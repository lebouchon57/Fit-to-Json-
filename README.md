# FIT to CSV — Progressive Web App (PWA)

Application Web 100 % autonome et mobile-first pour convertir vos fichiers d'activités Garmin `.FIT` en `.CSV` UTF-8 prêts pour Google Gemini — sans backend, sans compilation Node et sans dépendre d'un PC.

## Structure du projet

- `index.html` : Interface Split-Screen adaptative (Google Drive `.FIT` → Gemini `.CSV`).
- `styles.css` : Styles mobile-first avec dégradé crépusculaire, zone sûre encoche (`env(safe-area-inset-*)`) et bascule portrait/paysage.
- `fit-parser.js` : Décodeur binaire Garmin `.FIT` 100 % navigateur (protocole FIT v1/v2, Little/Big Endian, champs développeurs, horodatages compressés, `Record` / `Lap` / `Session`).
- `app.js` : Contrôleur principal, Web Share API (`navigator.share` avec fichier CSV joint) et sauvegarde via File System Access API / téléchargement Blob.
- `manifest.json` & `sw.js` : Manifeste installable (`standalone`) et Service Worker pour l'utilisation hors-ligne.
- `icons/` : Icônes PWA `192x192`, `512x512`, `maskable` et Apple Touch Icon.
- `tests/` : Tests unitaires Node (`node --test`).

## Déploiement direct depuis un smartphone (sans PC)

1. Poussez ce dépôt sur GitHub (chaque fichier est directement éditable depuis l'éditeur web mobile GitHub).
2. Dans **Settings → Pages** sur GitHub :
   - Source : **Deploy from a branch**
   - Branch : `main` / Folder : **`/ (root)`**
3. Ouvrez l'URL générée (`https://<votre-pseudo>.github.io/<votre-repo>/`) sur Chrome Android ou Safari iOS, puis touchez **« Installer l'app »** / **« Ajouter à l'écran d'accueil »**.
