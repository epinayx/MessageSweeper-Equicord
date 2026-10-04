/*
 * MessageSweeper - Equicord user plugin
 */

import { definePluginSettings } from "@api/Settings";
import { addChannelToolbarButton, ChannelToolbarButton, removeChannelToolbarButton } from "@api/HeaderBar";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Forms, GuildChannelStore, GuildStore, React, RestAPI, UserStore } from "@webpack/common";

const logger = new Logger("MessageSweeper");
const DELETE_DELAY_MS = 700;

const settings = definePluginSettings({
    deleteDelay: { type: OptionType.NUMBER, description: "Delai ms entre chaque suppression.", default: DELETE_DELAY_MS },
    debugLogs: { type: OptionType.BOOLEAN, description: "Logs dans DevTools.", default: false },
});

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

type Status = "queued" | "scanning" | "running" | "done" | "stopped";

interface SweepJob {
    id: string;
    channelId: string;
    deleted: number;
    total: number;
    found: number;
    status: Status;
    abort: AbortController;
}

const jobs: SweepJob[] = [];
const listeners = new Set<() => void>();
function notify() { listeners.forEach(l => l()); }

const isActive = (j: SweepJob) => j.status === "queued" || j.status === "scanning" || j.status === "running";

// Parcourt tout l'historique du salon et renvoie les IDs de tes messages supprimables
async function scanOwn(channelId: string, userId: string, signal: AbortSignal, onFound: (n: number) => void): Promise<string[]> {
    const ids: string[] = [];
    let before: string | undefined;
    while (!signal.aborted) {
        let batch: any[] = [];
        try {
            const res = await RestAPI.get({
                url: `/channels/${channelId}/messages`,
                query: { limit: 100, ...(before ? { before } : {}) },
            });
            batch = res?.body ?? [];
        } catch (err: any) {
            if (err?.status === 429) {
                await sleep(((err?.body?.retry_after ?? 1) * 1000) + 300);
                continue;
            }
            logger.error("fetch messages failed", channelId, err?.status, err?.body ?? err);
            break;
        }
        if (!Array.isArray(batch) || batch.length === 0) break;
        before = batch[batch.length - 1].id;
        for (const m of batch) {
            // 0 = normal, 19 = reponse, 20 = slash command, 23 = context menu
            if (m?.author?.id === userId && [0, 19, 20, 23].includes(m.type)) ids.push(m.id);
        }
        onFound(ids.length);
    }
    return ids;
}

async function deleteAll(job: SweepJob, userId: string, signal: AbortSignal) {
    const delay = Math.max(300, Number(settings.store.deleteDelay) || DELETE_DELAY_MS);

    // Passes successives : scan -> suppression. On s'arrete quand un passage ne supprime plus rien.
    while (!signal.aborted) {
        job.status = "scanning";
        job.found = 0;
        notify();

        const ids = await scanOwn(job.channelId, userId, signal, n => { job.found = n; notify(); });
        if (signal.aborted) return;
        if (ids.length === 0) break;

        job.total = job.deleted + ids.length;
        job.status = "running";
        notify();

        let deletedThisPass = 0;
        for (const id of ids) {
            if (signal.aborted) return;
            let tries = 0;
            while (tries++ < 5 && !signal.aborted) {
                try {
                    await RestAPI.del({ url: `/channels/${job.channelId}/messages/${id}` });
                    job.deleted++;
                    deletedThisPass++;
                    notify();
                    if (settings.store.debugLogs) logger.info("deleted", id, `${job.deleted}/${job.total}`);
                    break;
                } catch (err: any) {
                    if (err?.status === 429) {
                        await sleep(((err?.body?.retry_after ?? 1) * 1000) + 300);
                        continue;
                    }
                    logger.error("delete failed", id, err?.status, err?.body ?? err);
                    break;
                }
            }
            await sleep(delay);
        }

        if (deletedThisPass === 0) break;
    }
}

function getGuildList(): { id: string; name: string; }[] {
    try {
        return Object.values(GuildStore.getGuilds() as Record<string, any>)
            .map((g: any) => ({ id: g.id as string, name: g.name as string }))
            .sort((x, y) => x.name.localeCompare(y.name));
    } catch { return []; }
}

function getGuildChannelIds(guildId: string): string[] {
    const ids: string[] = [];
    const guildIds = guildId === "__all__" ? getGuildList().map(g => g.id) : [guildId];
    for (const gid of guildIds) {
        try {
            const data = GuildChannelStore.getChannels(gid);
            for (const entry of (data?.SELECTABLE ?? [])) {
                const ch = entry?.channel;
                if (ch?.id && [0, 2, 5, 13].includes(ch.type)) ids.push(ch.id);
            }
        } catch { }
    }
    return ids;
}

// File d'attente : un salon a la fois
let queue: Promise<any> = Promise.resolve();

function runJob(job: SweepJob) {
    const abort = new AbortController();
    job.abort = abort;
    job.status = "queued";
    notify();
    const uid = UserStore.getCurrentUser()?.id ?? "";
    queue = queue
        .then(() => abort.signal.aborted ? undefined : deleteAll(job, uid, abort.signal))
        .then(() => {
            if (job.abort === abort && !abort.signal.aborted) {
                job.status = "done";
                if (job.total < job.deleted) job.total = job.deleted;
                notify();
            }
        })
        .catch(e => { logger.error("job crashed", e); });
}

function startJob(channelId: string) {
    const job: SweepJob = { id: `${Date.now()}-${channelId}-${Math.random().toString(36).slice(2, 6)}`, channelId, deleted: 0, total: 0, found: 0, status: "queued", abort: new AbortController() };
    jobs.unshift(job);
    runJob(job);
}

function stopJob(job: SweepJob) { job.abort.abort(); job.status = "stopped"; notify(); }
function restartJob(job: SweepJob) { runJob(job); }
function clearDone() { jobs.splice(0, jobs.length, ...jobs.filter(isActive)); notify(); }

function statusText(j: SweepJob): string {
    const count = j.total > 0 ? `${j.deleted}/${j.total}` : `${j.deleted}`;
    switch (j.status) {
        case "queued": return "⏳ en attente…";
        case "scanning": return `🔍 analyse… ${j.found} trouvés${j.deleted ? ` (${j.deleted} déjà supprimés)` : ""}`;
        case "running": return `⟳ ${count} supprimés`;
        case "done": return `✓ ${count} supprimés`;
        default: return `⏹ ${count} supprimés`;
    }
}

function SweeperPanel({ onClose }: { onClose: () => void; }) {
    const [, forceUpdate] = React.useState(0);
    const [tab, setTab] = React.useState<"new" | "jobs">("new");
    const [channelId, setChannelId] = React.useState("");
    const [error, setError] = React.useState("");
    const [confirmAll, setConfirmAll] = React.useState(false);
    const [guildId, setGuildId] = React.useState("");
    const guilds = React.useMemo(() => getGuildList(), []);
    const selName = guildId === "__all__" ? "tous les serveurs" : (guilds.find(g => g.id === guildId)?.name ?? "");

    React.useEffect(() => {
        const l = () => forceUpdate(n => n + 1);
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, []);

    function addJob() {
        const id = channelId.trim();
        if (!id) { setError("Entre un ID de channel."); return; }
        if (!/^\d+$/.test(id)) { setError("ID invalide."); return; }
        startJob(id);
        setChannelId(""); setError("");
        setTab("jobs");
    }

    function addGuildJobs() {
        const ids = getGuildChannelIds(guildId);
        if (!ids.length) { setError("Aucun channel trouve."); setConfirmAll(false); return; }
        for (const id of ids) startJob(id);
        setConfirmAll(false);
        setGuildId("");
        setTab("jobs");
    }

    const runningCount = jobs.filter(isActive).length;
    const totalDeleted = jobs.reduce((a, j) => a + j.deleted, 0);

    function Btn({ label, onClick, bg, disabled = false, small = false }: any) {
        return <button onClick={onClick} disabled={disabled} style={{ border: "none", cursor: disabled ? "default" : "pointer", padding: small ? "4px 10px" : "8px 16px", borderRadius: 4, fontSize: small ? 12 : 13, fontWeight: 600, background: disabled ? "var(--background-modifier-accent)" : bg, color: disabled ? "var(--text-muted)" : "white", whiteSpace: "nowrap" }}>{label}</button>;
    }

    const optStyle = { background: "#2b2d31", color: "#dbdee1" };

    return (
        <div style={{ position: "fixed", bottom: 60, right: 16, width: 380, background: "var(--modal-background)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", zIndex: 10000, display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--background-modifier-accent)" }}>
            <div style={{ padding: "14px 16px 0", borderBottom: "1px solid var(--background-modifier-accent)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: "var(--header-primary)" }}>Delete message by t.me/epinay</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {runningCount > 0 && <span style={{ fontSize: 11, background: "var(--status-danger)", color: "white", borderRadius: 10, padding: "2px 7px", fontWeight: 700 }}>{runningCount} en cours</span>}
                        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--interactive-normal)", fontSize: 18, lineHeight: 1, padding: 0 }}>✕</button>
                    </div>
                </div>
                <div style={{ display: "flex" }}>
                    {(["new", "jobs"] as const).map(t => (
                        <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "6px 0", background: "none", border: "none", borderBottom: `2px solid ${tab === t ? "var(--brand-experiment)" : "transparent"}`, color: tab === t ? "var(--text-normal)" : "var(--text-muted)", cursor: "pointer", fontSize: 13, fontWeight: tab === t ? 600 : 400 }}>
                            {t === "new" ? "Nouveau" : `Tâches${jobs.length ? ` (${jobs.length})` : ""}`}
                        </button>
                    ))}
                </div>
            </div>

            {tab === "new" && (
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>ID du channel</div>
                        <div style={{ display: "flex", gap: 8 }}>
                            <input style={{ flex: 1, background: "var(--input-background)", border: `1px solid ${error ? "var(--status-danger)" : "var(--input-border)"}`, borderRadius: 4, color: "var(--text-normal)", padding: "8px 10px", fontSize: 14, outline: "none" }}
                                placeholder="123456789012345678"
                                value={channelId}
                                onChange={e => { setChannelId((e.target as HTMLInputElement).value); setError(""); }}
                                onKeyDown={e => e.key === "Enter" && addJob()}
                            />
                            <Btn label="Lancer" onClick={addJob} bg="var(--brand-experiment)" disabled={!channelId.trim()} />
                        </div>
                        {error && <div style={{ fontSize: 12, color: "var(--status-danger)", marginTop: 4 }}>{error}</div>}
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>💡 Clic droit sur un channel → Copier l'identifiant</div>
                    </div>
                    <div style={{ height: 1, background: "var(--background-modifier-accent)" }} />
                    <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Supprimer sur un serveur</div>
                        <select
                            value={guildId}
                            onChange={e => { setGuildId((e.target as HTMLSelectElement).value); setConfirmAll(false); }}
                            style={{ width: "100%", background: "#2b2d31", border: "1px solid #3f4147", borderRadius: 4, color: "#dbdee1", padding: "8px 10px", fontSize: 14, outline: "none", marginBottom: 8, colorScheme: "dark" }}
                        >
                            <option value="" style={optStyle}>Choisir un serveur…</option>
                            <option value="__all__" style={optStyle}>🌐 Tous les serveurs</option>
                            {guilds.map(g => <option key={g.id} value={g.id} style={optStyle}>{g.name}</option>)}
                        </select>
                        {guildId && !confirmAll && (
                            <button onClick={() => setConfirmAll(true)} style={{ width: "100%", padding: "10px", background: "rgba(237,66,69,0.1)", border: "1px solid var(--status-danger)", borderRadius: 6, color: "var(--status-danger)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                                Supprimer mes messages sur {selName}
                            </button>
                        )}
                        {guildId && confirmAll && (
                            <div style={{ background: "rgba(237,66,69,0.1)", border: "1px solid var(--status-danger)", borderRadius: 6, padding: 12 }}>
                                <div style={{ fontSize: 13, color: "var(--text-normal)", marginBottom: 10 }}>⚠️ Supprimer <strong>TOUS</strong> tes messages sur <strong>{selName}</strong> ?</div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <Btn label="Annuler" onClick={() => setConfirmAll(false)} bg="var(--background-modifier-accent)" />
                                    <Btn label="Oui, supprimer" onClick={addGuildJobs} bg="var(--status-danger)" />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {tab === "jobs" && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {jobs.length === 0 ? (
                        <div style={{ padding: "32px 16px", textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>Aucune tâche.</div>
                    ) : (
                        <>
                            <div style={{ maxHeight: 300, overflowY: "auto" }}>
                                {jobs.map(job => {
                                    const pct = job.total > 0 ? Math.min(100, Math.round((job.deleted / job.total) * 100)) : 0;
                                    const color = job.status === "done" ? "var(--status-positive)" : job.status === "stopped" ? "var(--text-muted)" : "var(--status-danger)";
                                    return (
                                        <div key={job.id} style={{ padding: "10px 16px", borderBottom: "1px solid var(--background-modifier-accent)" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                                <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: color }} />
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ fontSize: 12, color: "var(--text-normal)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.channelId}</div>
                                                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{statusText(job)}</div>
                                                </div>
                                                {isActive(job) && <Btn small label="Stop" onClick={() => stopJob(job)} bg="var(--status-danger)" />}
                                                {job.status === "stopped" && <Btn small label="Relancer" onClick={() => restartJob(job)} bg="var(--brand-experiment)" />}
                                            </div>
                                            {job.total > 0 && (
                                                <div style={{ height: 3, background: "var(--background-modifier-accent)", borderRadius: 2, overflow: "hidden", marginTop: 8 }}>
                                                    <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width 0.2s" }} />
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            <div style={{ padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--background-modifier-accent)" }}>
                                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Total : {totalDeleted} supprimés</span>
                                <Btn small label="Nettoyer terminés" onClick={clearDone} bg="var(--background-modifier-accent)" />
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

function TrashIcon() {
    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><line x1="10" y1="11" x2="10" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><line x1="14" y1="11" x2="14" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
}

function ToolbarBtn() {
    const [open, setOpen] = React.useState(false);
    const [, forceUpdate] = React.useState(0);
    React.useEffect(() => {
        const l = () => forceUpdate(n => n + 1);
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, []);
    const runningCount = jobs.filter(isActive).length;
    return (
        <>
            <div style={{ position: "relative", display: "inline-flex" }}>
                <ChannelToolbarButton icon={TrashIcon} tooltip="MessageSweeper" onClick={() => setOpen(o => !o)} selected={open} />
                {runningCount > 0 && <div style={{ position: "absolute", top: -4, right: -4, width: 16, height: 16, borderRadius: "50%", background: "var(--status-danger)", fontSize: 10, fontWeight: 700, color: "white", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>{runningCount}</div>}
            </div>
            {open && <SweeperPanel onClose={() => setOpen(false)} />}
        </>
    );
}

export default definePlugin({
    name: "MessageSweeper",
    description: "Supprime tes messages dans un channel ou sur un serveur.",
    authors: [{ name: "local", id: 0n }],
    settings,
    dependencies: ["HeaderBarAPI"],
    settingsAboutComponent: () => <Forms.FormText>Icone poubelle dans la toolbar. <span style={{ color: "var(--text-danger)" }}>Suppression irreversible.</span></Forms.FormText>,
    start() { addChannelToolbarButton("message-sweeper", () => <ToolbarBtn />); },
    stop() { removeChannelToolbarButton("message-sweeper"); },
});
