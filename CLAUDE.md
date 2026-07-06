# Contexte projet — homebridge-somfy-rts-shutters

Plugin Homebridge custom pour volets roulants **Somfy RTS** pilotés par un transceiver
**RFXCOM RFX-433EMC** (nouvelle gamme 2024+, base ESP32 — PAS un RFXtrx433E) branché en
USB sur ce Mac Mini M1 qui héberge Homebridge. Basé sur
sylvainleroux/homebridge-rfxcom-accessories, réduit aux volets uniquement.

Principe : les moteurs RTS n'ont aucun retour de position, donc l'accessoire HomeKit
`WindowCovering` simule la position en convertissant le % demandé en durée de commande
up/down (calibrée par volet via `openDurationSeconds`/`closeDurationSeconds`), puis
envoie un `stop` au bon moment pour les positions intermédiaires.

## État du code (compilé et relu le 2026-07-04, prêt pour le jour J)

- `npm install && npm run build` passent sans erreur (Node 24, `rfxcom@2.6.2`).
  L'arborescence a été réorganisée pour correspondre au tsconfig : sources dans
  `src/` (+ `src/accessories/`), helpers dans `scripts/`.
- Un bug du repo d'origine a été corrigé volontairement dans notre version : les durées
  open/close étaient inversées dans `setTargetPosition`. Ne pas "recorriger" en sens
  inverse en comparant au repo d'origine.
- Relecture 2026-07-04 : 4 bugs corrigés dans `shutterAccessory.ts`, tous validés par
  banc de test simulé (mocks Homebridge) :
  1. estimation de position inversée pour les volets `reversed` (elle suivait la
     commande RF au lieu du sens logique) ;
  2. durées open/close croisées pour les volets `reversed` ;
  3. `stop` jamais envoyé quand la cible rattrapait la position estimée en plein
     mouvement (le moteur filait jusqu'à la butée) ;
  4. `forceCloseAtStartup` envoyait un `down` codé en dur, qui **ouvre** un volet
     `reversed` (+ TargetPosition non synchronisée).
  Invariant à préserver : toute la logique interne (durées, estimation, PositionState)
  raisonne en **direction logique** (position qui monte = ouverture) ; la commande RF
  `up`/`down` n'est dérivée qu'au moment de l'envoi (`reversed` ne fait qu'inverser la
  commande, jamais les durées ni l'estimation).
- `rfxcom@^2.6.1` est requis (2.6.0 = premier support du nouveau matériel RFX-433,
  firmwareType 0x14). Ne pas rétrograder.
- Note npm : `@serialport/bindings-cpp` a un script d'install natif (`node-gyp-build`)
  signalé par allow-scripts — si le port série ne s'ouvre pas le jour J, vérifier que
  ce binding natif s'est bien compilé.

## Spécificités matériel RFX-433EMC (vérifiées dans le RFX User Guide 2.05)

- Somfy RTS supporté via protocole RFY, bascule auto en émission 433,42 MHz,
  40 télécommandes virtuelles max (compteurs rolling code stockés dans le boîtier).
- Le boîtier est livré avec le **logiciel USB** (38400 bauds, protocole compatible
  RFXtrx) : c'est le seul compatible avec ce plugin. Ne jamais flasher la variante
  WiFi/LAN/MQTT (l'USB deviendrait debug-only à 115200 bauds).
- Firmware ≥ 4012 recommandé (les premiers 40xx avaient des soucis de connexion).
- **Boîtier confirmé RFX-433EMC** (2026-07-06) : mise à jour firmware par navigateur
  réussie (Web Serial → impossible sur un RFXtrx433E/PIC), variante **USB**, release
  **4050** active (affichée « 1050 / Unknown firmware » par node-rfxcom ≤ 2.6.2 qui ne
  connaît pas le type `0x46` — artefact d'affichage, ne pas s'en inquiéter). Boîtier
  beige (contrairement aux photos noires du site), pont USB **FTDI FT231X** devant
  l'ESP32-S3. Port macOS : `/dev/cu.usbserial-D30FC2G8` — stable au reboot (nom = n° de
  série FTDI). Après un flash, le boîtier attend un reset matériel : impulsion RTS/EN
  type esptool via les lignes série (scripts de la session du 2026-07-06), ou
  débranche/rebranche USB.
- ⚠️ Le port série n'accepte qu'un seul maître : arrêter le child bridge Somfy avant
  tout script direct (Homebridge le relance en ~1 s après un kill — utiliser une
  ouverture en boucle pour gagner la course, ou couper Homebridge). Un onglet Chrome
  Web Serial (flasher) verrouille le port en exclusif tant qu'il n'est pas fermé.

## Checklist jour d'installation (détail complet dans README.md)

1. `npm install && npm run build` — corriger les erreurs TS éventuelles.
2. Brancher le RFX-433EMC, identifier le port : `ls /dev/cu.*`.
3. Appairer chaque volet : sélectionner le canal du volet sur la télécommande 5 canaux,
   PROG ~2s au dos (le volet fait un jog), puis `node scripts/pair.js <port> <deviceId>`
   (nouveau jog). Vérifier avec `node scripts/jog.js <port> <deviceId> up` — obligatoire
   car un appairage sur mémoire moteur pleine semble réussir mais ne répond pas.
4. `deviceId` : format `0xID/unitCode`, ID libre de 0x00001 à 0xFFFFF (5 hexa max),
   unitCode 0–4. Un deviceId distinct par volet, à noter. Même deviceId sur plusieurs
   moteurs = groupe. Schéma conseillé : `0x00001/1`, `0x00001/2`, …
5. Chronométrer montée et descente complètes de chaque volet (les deux durées diffèrent
   souvent) → `openDurationSeconds`/`closeDurationSeconds`.
6. Configurer la plateforme `SomfyRTSShutters` dans la config Homebridge (schéma UI
   dispo via config.schema.json), installer le plugin (`npm link` ou
   `npm install /chemin/vers/le/dossier` depuis le dossier Homebridge), redémarrer.

## Limites connues (par conception RTS, pas des bugs)

- Le RFXCOM n'entend pas les télécommandes physiques : bouger un volet à la
  télécommande fait dériver la position simulée jusqu'à la prochaine course complète
  (0 % ou 100 %). Option `forceCloseAtStartup` pour resynchroniser au démarrage.
- Ne jamais réutiliser un ancien RFXtrx après migration, et ré-appairer tous les volets
  si le boîtier est remplacé/réinitialisé (rolling codes).
