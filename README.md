# MessageSweeper

> Plugin Equicord pour supprimer **tes propres messages** Discord en masse, dans un salon ou sur tout un serveur, avec compteur en direct (`3/289`), stop et relance.

> [!NOTE]
> Les plugins tiers ne sont PAS supportés par les développeurs d'Equicord. Utilisation à tes risques.

## Fonctionnalités

- 🗑️ Icône poubelle dans la barre d'outils du salon
- 🔢 Compteur de progression par salon (`14/289`) avec barre de progression
- 🔍 Analyse complète de l'historique du salon avant de supprimer, pour savoir combien de messages seront supprimés
- ⏹️ Boutons **Stop** et ▶️ **Relancer** sur chaque tâche
- 🌐 Menu déroulant pour supprimer sur **un serveur** ou sur **tous les serveurs**
- ⏳ File d'attente : les salons sont traités un par un pour éviter les rate limits
- ♻️ S'arrête automatiquement quand il ne reste plus aucun message de toi dans le salon
- ⚙️ Réglages : délai entre chaque suppression, logs de debug

## Installation

Il te faut Equicord [compilé depuis les sources](https://docs.equicord.org/) (les userplugins ne fonctionnent que comme ça).

```bash
cd Equicord/src/userplugins
git clone https://github.com/epinaydev/MessageSweeper-Equicord messageSweeper
cd ../..
pnpm build
```

Windows (PowerShell) :

```powershell
cd C:\chemin\vers\Equicord\src\userplugins
git clone https://github.com/epinaydev/MessageSweeper-Equicord messageSweeper
cd ..\..
pnpm build
```

Ensuite, quitte complètement Discord / Equibop, rouvre-le et active **MessageSweeper** dans Paramètres → Equicord → Plugins.

## Utilisation

1. Clique sur l'icône poubelle dans la barre d'outils du salon.
2. Onglet **Nouveau** :
   - colle l'ID d'un salon (clic droit sur le salon → *Copier l'identifiant*) puis clique sur **Lancer**, ou
   - choisis un serveur dans le menu déroulant (ou *Tous les serveurs*) et confirme.
3. Onglet **Tâches** : suis la progression, clique sur **Stop**, puis sur **Relancer** pour reprendre.

## Réglages

| Réglage | Description | Défaut |
| --- | --- | --- |
| `deleteDelay` | Délai en ms entre chaque suppression | `700` |
| `debugLogs` | Affiche les logs dans la console (`Ctrl+Shift+I`) | `false` |

## Remarques

- Seuls tes propres messages supprimables (normaux, réponses, slash commands) sont supprimés.
- Les salons dont tu ne peux pas lire l'historique (403) se terminent immédiatement avec `0` supprimé.
- Les rate limits de Discord (429) sont gérés automatiquement.
- Le total (`/289`) correspond aux messages trouvés au moment de l'analyse. Si tu en envoies d'autres pendant la suppression, un nouveau passage les rattrape.

## Mise à jour

```bash
cd Equicord/src/userplugins/messageSweeper
git pull
cd ../../..
pnpm build
```

## Dépannage

- **0 supprimé** : active `debugLogs`, relance, puis ouvre la console (`Ctrl+Shift+I`) et regarde les lignes `[MessageSweeper]` en rouge pour voir le code d'erreur (403, 404…).
- **Aucun changement après le build** : vérifie que Discord / Equibop charge bien ton build local (`dist`) et redémarre-le complètement.

## Support

Telegram : [epinay](https://t.me/epinay).
