# homebridge-somfy-rts-shutters

Plugin Homebridge minimaliste pour piloter des volets roulants **Somfy RTS** via un
transceiver **RFXCOM** (RFX-433EMC, RFX-433, RFXtrx433E ou RFXtrx433XL), en USB
direct sur la machine qui héberge Homebridge.

## ⚠️ Spécificités du RFX-433EMC (nouvelle gamme 2024+)

Le RFX-433EMC n'est **pas** un RFXtrx433E : c'est la nouvelle génération (base ESP32,
firmware "RFX-433" séries 4000). Points vérifiés dans le
[RFX User Guide officiel](http://www.rfxcom.com/WebRoot/StoreNL2/Shops/78165469/MediaGallery/Downloads/RFX_User_Guide.pdf) :

- ✅ **Somfy RTS supporté** via le protocole RFY (chapitre 13 du guide) : bascule
  automatique en émission à 433,42 MHz, jusqu'à **40** télécommandes RFY mémorisables
  (contre 30 sur le RFXtrx433E). Commandes et appairage identiques.
- ✅ **Protocole USB compatible RFXtrx** (38400 bauds) : la lib `node-rfxcom` utilisée
  par ce plugin fonctionne, **à condition d'être en version ≥ 2.6.0** (support explicite
  des nouveaux RFX433/RFX868 — c'est pourquoi `package.json` exige `rfxcom@^2.6.1`).
- ⚠️ Le boîtier est livré avec le **logiciel USB** préinstallé : c'est celui qu'il faut
  garder. Si un jour tu flashes la variante WiFi/LAN/**MQTT**, le port USB devient un
  simple port de debug (115200 bauds) et ce plugin ne pourra plus lui parler en USB.
- ⚠️ Garde le firmware à jour (≥ 4012 recommandé par RFXCOM) ; les tout premiers
  firmwares 40xx ont causé des soucis de connexion dans d'autres intégrations.
- ℹ️ Puce USB : les séries 2025+ embarquent un pont **FTDI FT231X** (port macOS
  `usbserial-<numéroDeSérie>`, stable au redémarrage et au changement de prise) ; les
  premières séries utilisaient d'autres puces (voir plus bas).
- ℹ️ Affichage firmware : les bibliothèques `rfxcom` ≤ 2.6.2 ne connaissent pas le type
  de firmware des séries récentes et affichent par ex. « 1050 / Unknown firmware » pour
  une release **4050** réelle — artefact cosmétique sans conséquence.

Basé sur la partie RFY de [homebridge-rfxcom-accessories](https://github.com/sylvainleroux/homebridge-rfxcom-accessories),
réduit aux seuls volets (pas de capteurs météo, pas de switches on/off), avec :

- exposition HomeKit native en `WindowCovering` (slider % dans l'app Maison) ;
- simulation de la position par **chronométrage** : le % cible envoyé par HomeKit est
  converti en une durée de commande `up`/`down` envoyée au RFXtrx (les moteurs RTS
  n'ont pas de retour de position réel) ;
- position simulée **persistée** entre deux redémarrages de Homebridge ;
- gestion des interruptions (nouvelle commande envoyée pendant qu'un volet bouge déjà) ;
- caractéristique `HoldPosition` optionnelle pour un stop manuel (app Eve / automatisation) ;
- pilotage **conscient de l'émission** : chronométrage ancré sur l'accusé d'émission du
  RFXtrx, ré-émission automatique des trames refusées, rollback de la position simulée
  en cas d'échec définitif (l'état ne ment jamais) + caractéristique `StatusFault` ;
- accessoires de **groupe** au comportement stateful (voir la section dédiée).

## ⚠️ Bug corrigé par rapport au plugin d'origine

Dans `rfyAccessory.ts` du repo d'origine, `openDurationSeconds` est utilisé pour la
commande `down` et `closeDurationSeconds` pour la commande `up` — les deux durées
sont inversées par rapport à ce que leur nom indique. Ici c'est corrigé :
`openDurationSeconds` = durée d'un `up` complet (fermé → ouvert), `closeDurationSeconds`
= durée d'un `down` complet (ouvert → fermé).

## Installation (le jour J, une fois le RFXtrx branché)

```bash
cd homebridge-somfy-rts-shutters
npm install
npm run build
npm link
```

Puis redémarrer Homebridge et ajouter la plateforme dans sa config (voir plus bas).

## Trouver le port série sur le Mac Mini M1

```bash
ls /dev/cu.*
```

Avec un RFX-433EMC série 2025+ (pont FTDI FT231X), le port apparaît comme
`/dev/cu.usbserial-XXXXXXXX` — le suffixe est le numéro de série de la puce, donc **le
nom est stable** au redémarrage et même en changeant de prise USB. Sur d'autres
séries/puces, il peut apparaître comme `/dev/cu.SLAB_USBtoUART`, `/dev/cu.wchusbserial*`
ou `/dev/cu.usbmodem*`. Compare la sortie de `ls /dev/cu.*` avant/après branchement
pour identifier le bon ; les drivers usuels sont inclus dans macOS récent (Ventura+).

## Appairage des volets (⚠️ RFXmngr est Windows-only, inutilisable sur le Mac Mini)

Le repo d'origine suppose l'usage de RFXmngr ou Domoticz pour appairer chaque volet
avec le RFXtrx avant de renseigner `deviceId` dans la config. Comme tu es sur Mac,
utilise plutôt le script fourni `scripts/pair.js`, qui envoie directement la commande
`PROGRAM` RFY via la lib `rfxcom` (celle-là même qu'utilise le plugin) — pas besoin
de RFXmngr :

```bash
node scripts/pair.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1
```

`deviceId` est un code **que tu choisis toi-même** : c'est l'adresse de la
"télécommande virtuelle" que le RFXCOM émulera pour ce volet (le moteur la mémorise
lors du PROG, exactement comme une vraie télécommande supplémentaire).

Format `0xID/unitCode` avec :
- **ID** de `0x00001` à `0xFFFFF` (5 chiffres hexa max, vérifié dans la lib rfxcom) ;
- **unitCode** de `0` à `4` (sous-type RFY standard).

Chaque couple ID+unitCode est une télécommande virtuelle indépendante (jusqu'à 40
mémorisables dans le RFX-433EMC, avec leur compteur de rolling code). Règles :
- un `deviceId` distinct par volet, à noter précieusement (il va dans `config.json`) ;
- le même `deviceId` appairé sur plusieurs moteurs crée un **groupe** (ils bougent
  ensemble) — pratique pour un accessoire "tous les volets", à éviter sinon ;
- schéma simple conseillé : `0x00001/1`, `0x00001/2`... puis `0x00002/1` au-delà de
  4 volets.

Procédure Somfy RTS classique pour associer un **nouveau** récepteur (ici le RFXtrx
virtuel) à un moteur **déjà appairé** avec au moins une télécommande :

1. Sur une télécommande déjà fonctionnelle pour ce volet, appuie 2s sur **PROG**
   jusqu'à ce que le volet fasse un petit à-coup (jog). Le moteur entre en mode
   association pour ~2 minutes.
2. Lance `node scripts/pair.js <tty> <deviceId>` et appuie sur Entrée quand demandé
   (ça envoie la commande PROG du RFXtrx).
3. Le volet doit refaire un jog : l'appairage a réussi, `deviceId` est utilisable.

Si le moteur est **neuf et jamais appairé** (pas de télécommande d'origine), il faut
d'abord l'associer via le bouton PROG câblé au moteur (procédure du fabricant du
moteur/volet, pas du ressort de ce plugin) avant de pouvoir répéter l'étape ci-dessus.

Autres commandes utiles pour tester/calibrer manuellement :

```bash
# envoyer up / down / stop une fois, chrono en main, pour mesurer les durées réelles
node scripts/jog.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1 up
node scripts/jog.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1 down
node scripts/jog.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1 stop

# dépairer un deviceId de ce moteur
node scripts/jog.js /dev/cu.usbserial-XXXXXXXX 0x0A1B2C/1 erase
```

## Config Homebridge

```json
{
  "platforms": [
    {
      "platform": "SomfyRTSShutters",
      "name": "Somfy RTS Shutters",
      "tty": "/dev/cu.usbserial-XXXXXXXX",
      "debug": false,
      "shutters": [
        {
          "name": "Volet Salon",
          "deviceId": "0x00001/1",
          "reversed": false,
          "openDurationSeconds": 25.4,
          "closeDurationSeconds": 23.8,
          "forceCloseAtStartup": false
        },
        {
          "name": "Volet Chambre",
          "deviceId": "0x00001/2",
          "openDurationSeconds": 20,
          "closeDurationSeconds": 20
        },
        {
          "name": "Tous les volets",
          "deviceId": "0x00002/1",
          "openDurationSeconds": 25.4,
          "closeDurationSeconds": 23.8,
          "members": ["0x00001/1", "0x00001/2"]
        }
      ]
    }
  ]
}
```

Les durées acceptent les décimales (précision au dixième de seconde recommandée pour
des positions intermédiaires justes).

### `reversed`

À activer si la commande RF `up` **ferme** le volet au lieu de l'ouvrir (câblage ou
appairage inversé). Important : `reversed` n'inverse **que** la commande RF envoyée.
`openDurationSeconds` et `closeDurationSeconds` restent définis par le trajet
physique du volet — `openDurationSeconds` = durée d'une ouverture complète (0 % → 100 %),
quel que soit le bouton qui la déclenche. Chronomètre donc toujours le volet, pas la
commande.

### Stores banne (awnings) : quelle convention choisir ?

HomeKit affiche « Ouvert » à 100 %. Pour un store banne, deux conventions sont
possibles — le plugin gère les deux, à toi de choisir :

| Convention | « Ouvert » (100 %) = | Réglages |
|---|---|---|
| A | toile **déployée** | `reversed: true` (le déploiement se fait par la commande RF `down`), `openDurationSeconds` = durée de déploiement |
| B | toile **repliée** (cohérent avec des volets roulants : « ouvert » = on voit le ciel) | `reversed: false`, `openDurationSeconds` = durée de repli |

⚠️ Dans la convention B, « Fermer » **déploie** la toile : ne combine pas cette
convention avec `forceCloseAtStartup` (chaque redémarrage de Homebridge sortirait le
store). Pour la resynchronisation périodique, préfère une automatisation HomeKit
quotidienne vers la position 100 %.

### Calibrer `openDurationSeconds` / `closeDurationSeconds`

Chronomètre chaque volet en conditions réelles avec `scripts/jog.js` (commande `up`
puis `down`, du bas jusqu'en haut et inversement), et renseigne les durées mesurées
+ 1 à 2 secondes de marge. Comme les moteurs RTS ont leurs propres fins de course,
aller à 0% ou 100% ne déclenche pas de `stop` explicite du plugin (le moteur
s'arrête tout seul) — ça permet de re-synchroniser la position simulée avec la
réalité à chaque ouverture/fermeture complète.

### `forceCloseAtStartup`

Si `true`, envoie un `down` complet à chaque démarrage de Homebridge pour garantir
une position simulée fiable (utile si le drift s'accumule). Sinon, la dernière
position connue est restaurée depuis le cache Homebridge.

## Accessoires de groupe (`members`)

Pour piloter plusieurs volets/stores d'un seul geste : appaire un deviceId dédié (ex.
`0x00002/1`) sur **chacun** des moteurs concernés (même procédure PROG, répétée moteur
par moteur), déclare-le comme un volet normal et liste ses membres :

```json
{ "name": "Tous les volets", "deviceId": "0x00002/1",
  "openDurationSeconds": 25, "closeDurationSeconds": 24,
  "members": ["0x00001/1", "0x00001/2"] }
```

Comportement (« dispatch hybride ») :

- **Cible 0 % ou 100 %** : une **seule trame radio** part via la télécommande de groupe —
  départ parfaitement synchrone, et les butées moteur garantissent l'exactitude quel que
  soit le point de départ de chacun. Les membres suivent en simulation (aucune trame
  supplémentaire).
- **Cible intermédiaire (1-99 %)** : une trame de groupe unique ferait courir tous les
  moteurs pendant la même durée — impossible d'amener des volets partis de positions
  différentes au même pourcentage. Le plugin **commande alors chaque membre
  individuellement** (sa trame, son stop chronométré avec ses durées) : chacun atteint
  réellement la position demandée.
- **HoldPosition sur le groupe** : un seul stop radio (la télécommande de groupe arrête
  physiquement tous les moteurs), les simulations des membres se figent, et leurs stops
  programmés sont annulés — jamais de trame « stop » sur un moteur à l'arrêt (elle
  déclencherait sa position favorite « my »).
- Quand un membre bouge individuellement, le groupe affiche la **moyenne** de ses membres.

## Limites connues

- Pas de retour de position réel : si le volet est aussi actionné par sa télécommande
  d'origine en dehors de Homebridge, la position simulée dérive jusqu'à la prochaine
  course complète (0% ou 100%).
- Si le RFXCOM est remplacé ou réinitialisé, les compteurs de rolling code repartent
  de zéro : chaque volet devra être ré-appairé.
- Si tu migres un jour depuis un vieux RFXtrx vers le RFX-433EMC, ré-appaire chaque
  volet avec le nouveau boîtier et **n'utilise plus l'ancien** : le code tournant
  (rolling code) RTS se désynchroniserait (chapitre 14 du RFX User Guide).
