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
- ℹ️ Puce USB non-FTDI : sur macOS le port série peut apparaître sous un nom différent
  de l'habituel `usbserial-XXXXXXXX` (voir plus bas).

Basé sur la partie RFY de [homebridge-rfxcom-accessories](https://github.com/sylvainleroux/homebridge-rfxcom-accessories),
réduit aux seuls volets (pas de capteurs météo, pas de switches on/off), avec :

- exposition HomeKit native en `WindowCovering` (slider % dans l'app Maison) ;
- simulation de la position par **chronométrage** : le % cible envoyé par HomeKit est
  converti en une durée de commande `up`/`down` envoyée au RFXtrx (les moteurs RTS
  n'ont pas de retour de position réel) ;
- position simulée **persistée** entre deux redémarrages de Homebridge ;
- gestion des interruptions (nouvelle commande envoyée pendant qu'un volet bouge déjà) ;
- caractéristique `HoldPosition` optionnelle pour un stop manuel (app Eve / automatisation).

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

Avec le RFX-433EMC (puce non-FTDI, base ESP32), le port peut apparaître comme
`/dev/cu.usbserial-0001`, `/dev/cu.SLAB_USBtoUART`, `/dev/cu.wchusbserial*` ou
`/dev/cu.usbmodem*` selon la puce embarquée. Compare la sortie de `ls /dev/cu.*`
avant/après branchement pour identifier le bon. Les drivers CP210x/CH34x sont inclus
dans macOS récent (Ventura+), rien à installer normalement sur le Mac Mini M1.

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
          "name": "Salon",
          "deviceId": "0x0A1B2C/1",
          "reversed": false,
          "openDurationSeconds": 25,
          "closeDurationSeconds": 23,
          "forceCloseAtStartup": false
        },
        {
          "name": "Chambre",
          "deviceId": "0x0A1B2C/2",
          "openDurationSeconds": 20,
          "closeDurationSeconds": 20
        }
      ]
    }
  ]
}
```

### `reversed`

À activer si la commande RF `up` **ferme** le volet au lieu de l'ouvrir (câblage ou
appairage inversé). Important : `reversed` n'inverse **que** la commande RF envoyée.
`openDurationSeconds` et `closeDurationSeconds` restent définis par le trajet
physique du volet — `openDurationSeconds` = durée d'une ouverture complète (0 % → 100 %),
quel que soit le bouton qui la déclenche. Chronomètre donc toujours le volet, pas la
commande.

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

## Limites connues

- Pas de retour de position réel : si le volet est aussi actionné par sa télécommande
  d'origine en dehors de Homebridge, la position simulée dérive jusqu'à la prochaine
  course complète (0% ou 100%).
- Si le RFXCOM est remplacé ou réinitialisé, les compteurs de rolling code repartent
  de zéro : chaque volet devra être ré-appairé.
- Si tu migres un jour depuis un vieux RFXtrx vers le RFX-433EMC, ré-appaire chaque
  volet avec le nouveau boîtier et **n'utilise plus l'ancien** : le code tournant
  (rolling code) RTS se désynchroniserait (chapitre 14 du RFX User Guide).
