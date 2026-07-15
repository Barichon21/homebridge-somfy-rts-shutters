# Changelog

## 0.3.1 (2026-07-14)

- Observabilité : les réponses du RFXtrx à chaque commande sont désormais corrélées au
  volet émetteur et loguées — ACK en debug, absence de confirmation en warning nuancé,
  refus (« Unknown RFY remote ID », NAK…) en warning explicite « le moteur n'a pas reçu
  cet ordre ». Les pannes silencieuses (volet désappairé, trame perdue) deviennent
  visibles d'un coup d'œil dans les logs Homebridge.

## 0.3.0 (2026-07-13)

- **Groupes : dispatch hybride.** Cible intermédiaire (1-99 %) → chaque membre est
  commandé individuellement (sa trame, son stop, ses durées) et atteint réellement le
  pourcentage demandé quel que soit son point de départ. Cible 0/100 % → trame de groupe
  unique conservée (départ synchrone, exactitude par les butées moteur).
- HoldPosition d'un groupe : stop radio unique + gel des simulations membres, avec
  annulation de leurs stops programmés (aucune trame « stop » sur moteur à l'arrêt, qui
  déclencherait la position « my »).

## 0.2.0 (2026-07-13)

- Accessoires de groupe (`members` dans la config) : les membres suivent les mouvements
  du groupe en simulation, le groupe affiche la moyenne de ses membres.
- Réconciliation au démarrage d'un état persisté en plein mouvement (un moteur RTS finit
  sa course : l'état est ramené à l'extrémité du trajet au lieu de rester « Ouverture… »).

## 0.1.1 (2026-07-06)

- Durcissement : plus aucun crash du (child) bridge sur `tty` manquant, erreur du port
  série ou `deviceId` invalide (unitCode RFY 0-4) — accessoires inertes avec log explicite.

## 0.1.0 (2026-07-06)

- Version initiale : WindowCovering natif avec position simulée par chronométrage
  calibré, persistance, gestion des interruptions, HoldPosition, scripts d'appairage
  et de calibration sans RFXmngr.
