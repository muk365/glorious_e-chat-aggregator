# Glorious_E - Unified Combined Multi-Chat Aggregator

Un agrégateur de chat en temps réel qui combine les trois chats de **Glorious_E** (**Kick**, **Twitch** et **YouTube Live**) en **un seul et unique flux de discussion**, prêt pour un déploiement 100% cloud sur **Render.com**.

Chaque message affiche une **icône distincte devant le pseudo** pour identifier instantanément sa plateforme d'origine :
- 🟢 **Kick** (icône logo Kick vert fluo)
- 🟣 **Twitch** (icône bulle Twitch violette)
- 🔴 **YouTube** (icône bouton Play YouTube rouge)

---

## 🚀 Déploiement sur Render.com (Solution Cloud Clé en Main)

Le projet est configuré pour être déployé en 1 clic sur **[Render.com](https://render.com/)** avec un serveur Node.js tout-en-un (`server.js`) qui gère les fichiers statiques, l'API REST et les WebSockets sur un port unique.

### Étapes simples de déploiement :

1. **Créer un dépôt GitHub** :
   - Allez sur [github.com/new](https://github.com/new) et créez un nouveau dépôt (ex: `glorious-e-chat`).
   - Poussez ce dossier vers GitHub :
     ```bash
     git remote add origin https://github.com/VOTRE_PSEUDO/glorious-e-chat.git
     git branch -M main
     git push -u origin main
     ```

2. **Connecter sur Render.com** :
   - Rendez-vous sur votre tableau de bord [Render.com](https://dashboard.render.com/).
   - Cliquez sur **New +** > **Web Service**.
   - Sélectionnez votre dépôt GitHub `glorious-e-chat`.

3. **Paramètres de configuration (Render détecte automatiquement `render.yaml`)** :
   - **Name** : `glorious-e-chat` (ou le nom de votre choix)
   - **Environment / Runtime** : `Node`
   - **Build Command** : *(laisser vide)*
   - **Start Command** : `node server.js`
   - **Instance Type** : `Free`

4. **Terminé !**
   Render génère une URL publique sécurisée en HTTPS et WSS (ex: `https://glorious-e-chat.onrender.com`).
   Le frontend s'y connecte automatiquement en WebSocket sécurisé (`wss://`).

---

## 💻 Exécution en Local

Vous pouvez également lancer le serveur directement sur votre machine sans dépendance externe :

```bash
# Lancer le serveur Node.js tout-en-un
npm start
# ou
node server.js
```

Puis ouvrez votre navigateur sur : **[http://localhost:8088](http://localhost:8088)**

*(Alternative pour XAMPP : Vous pouvez aussi continuer à utiliser `http://localhost/chat-aggregator-baba/` avec Apache/PHP et le script [`start-chat.bat`](file:///d:/XAMPP/htdocs/chat-aggregator-baba/start-chat.bat)).*

---

## ✨ Fonctionnalités Incluses

1. **Un seul flux de discussion unifié** :
   - Tous les messages de Kick, Twitch et YouTube défilent ensemble par ordre chronologique avec l'heure d'envoi.
   - Contournement des restrictions d'iframe : connexion directe aux WebSockets de Twitch et Centrifugo de Kick.
2. **Badges et icônes de plateformes** :
   - Icône Kick, Twitch ou YouTube placée directement devant chaque nom d'utilisateur.
   - Couleurs de pseudo personnalisées préservées.
   - Mise en valeur des mentions `@pseudo` et des liens cliquables.
3. **Support complet des émotes 7TV (Twitch & Kick)** :
   - Récupération et mise en cache des **990+ émotes 7TV de Glorious_E** (`Tarkov`, `TriKool`, `Pag`, `KEKW`, `catJAM`, `peepoSad`, `FAHHHHHHH`, `bobo`, etc.) ainsi que des émotes 7TV globales.
   - Support des émotes natives Twitch (abonnés, partenaires).
   - Support des émotes natives Kick (`[emote:ID:Name]`) et des stickers YouTube.
   - Les émotes animées (WebP) s'affichent correctement sans être altérées par les liens HTTP.
4. **Filtres interactifs (en haut)** :
   - Cliquez sur les boutons **Kick**, **Twitch** ou **YouTube** pour filtrer et n'afficher que les plateformes souhaitées.
   - Filtre **@Mentions** (touche <kbd>4</kbd>) pour isoler les messages interpellant Glorious_E.
   - Filtre **Subs & Bits** (touche <kbd>5</kbd>) pour isoler instantanément les abonnements, dons de subs et bits.
   - Compteurs en temps réel des messages reçus pour chaque catégorie.
5. **Mise en valeur rouge des Subs, Gift Subs & Bits** :
   - Sur Twitch : Abonnements (`⭐ Sub`), Réabonnements (`⭐ Resub`), Subs offerts (`🎁 Gift Sub`), Bits (`💎 Bits`).
   - Sur YouTube : Super Chats (`💰 Super Chat`), Super Stickers (`🎨 Super Sticker`), Adhésions chaîne (`⭐ Member`).
   - Sur Kick : Abonnements (`⭐ Sub`) et Cadeaux de subs (`🎁 Gift Sub`).
   - Badge rouge distinctif devant le pseudo et bandeau rouge lumineux sur toute la ligne du message.
6. **Gestion dynamique de YouTube Live** :
   - Détection automatique du live du jour via `https://www.youtube.com/@GloriousE/live`.
   - Bouton **🔄 Auto-Detect Live** pour forcer la mise à jour immédiate si le streamer relance un live.
   - Champ de saisie pour coller manuellement n'importe quel lien YouTube ou ID (11 caractères).
6. **Outils de discussion** :
   - **Auto-scroll intelligent** : Le chat défile tout seul. Si vous remontez pour lire un message, le défilement se met en pause et un bouton flottant `↓ Nouveaux messages` apparaît.
   - Réglage de la taille de texte : boutons **A-** et **A+**.
   - Bouton **Clear** (Raccourci <kbd>X</kbd> ou <kbd>Suppr</kbd>) pour vider l'écran sans interférer avec <kbd>Ctrl+C</kbd>.
   - Mode Plein écran / Théâtre (Raccourci <kbd>F</kbd>) pour masquer les barres d'outils.
   - Tiroir vidéo rétractable **Video Stream** : pour regarder la vidéo du stream (Twitch, Kick ou YouTube) au-dessus du chat.
7. **Envoi direct de messages sur le chat Twitch de Glorious_E** :
   - Barre de discussion dédiée en bas du flux.
   - Connexion sécurisée officielle OAuth Twitch ("Connect Twitch to Chat").
   - Vos messages sont envoyés instantanément dans le chat `#glorious_e` via l'API officielle Twitch Helix et apparaissent directement dans le flux unifié.

---

## 🔐 Configuration de l'Envoi Twitch (Optionnel)

Si vous souhaitez activer l'envoi de messages Twitch depuis votre déploiement Render :

1. Rendez-vous sur la console développeur Twitch : **[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)**
2. Cliquez sur **Register Your Application**.
   - **Name** : `Glorious E Chat Aggregator` (ou ce que vous voulez)
   - **OAuth Redirect URLs** :
     - Pour Render : `https://VOTRE-APP.onrender.com/auth/twitch/callback`
     - Pour tester en local : `http://localhost:8088/auth/twitch/callback`
   - **Category** : `Chat Bot` ou `Website Integration`
3. Cliquez sur **Create**, puis ouvrez votre application et cliquez sur **New Secret**.
4. Copiez votre **Client ID** et votre **Client Secret**.
5. Dans votre tableau de bord **Render.com** > votre service `glorious-e-chat` > onglet **Environment** :
   - Ajoutez la variable `TWITCH_CLIENT_ID` avec votre Client ID.
   - Ajoutez la variable `TWITCH_CLIENT_SECRET` avec votre Client Secret.
   - Cliquez sur **Save Changes**. Render redémarre automatiquement avec l'envoi Twitch activé !

*(Note : Sans ces clés, l'application reste 100% opérationnelle en mode lecture agrégée sans aucune erreur).*

---

## 🛠️ Architecture Technique

- **[`server.js`](file:///d:/XAMPP/htdocs/chat-aggregator-baba/server.js)** : Serveur Node.js vanilla haute performance (zéro dépendance npm requise).
  - Serveur de fichiers statiques (`public/index.html`, CSS, JS).
  - Client WebSocket IRC Twitch (`wss://irc-ws.chat.twitch.tv:443`).
  - Client WebSocket Kick Centrifugo (`wss://ws-chat.kick.cx/connection/websocket`) avec jeton d'authentification temps réel.
  - Poller YouTube Live Chat via InnerTube API.
  - Serveur WebSocket bidirectionnel pour streamer les messages combinés vers les navigateurs clients.
  - Flux OAuth Twitch & endpoints Helix Chat (`/auth/twitch`, `/auth/twitch/callback`, `/api/user`, `/api/chat/send`, `/api/chat/logout`).
  - Endpoints REST : `/api/youtube`, `/api/7tv_emotes`, `/api/history`, `/api/status_all`, `/health`.
- **[`public/js/app.js`](file:///d:/XAMPP/htdocs/chat-aggregator-baba/public/js/app.js)** : Client frontend dynamique.
  - Détecte automatiquement l'environnement (`ws://` en local ou `wss://` sur Render HTTPS).
  - Cache local des émotes 7TV pour un rendu instantané.
  - Gestion des filtres, du défilement, des raccourcis clavier et de l'envoi de messages Twitch.
- **[`render.yaml`](file:///d:/XAMPP/htdocs/chat-aggregator-baba/render.yaml)** : Fichier Blueprint de déploiement automatique pour Render.com.
