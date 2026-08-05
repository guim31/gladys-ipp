# Imprimantes IPP

Cette intégration surveille vos imprimantes réseau via le protocole standard
**IPP** (Internet Printing Protocol) — celui qu'utilise AirPrint. Elle
fonctionne entièrement en local : pas de compte, pas de cloud, pas de clé
d'API.

## Ce que vous obtenez

Un appareil Gladys par imprimante, avec :

- **un capteur par cartouche d'encre ou de toner** (niveau en %), avec
  historique — de quoi tracer la consommation dans le temps et déclencher des
  scènes (« encre noire sous 10 % → notification ») ;
- **l'état de l'imprimante** : `idle` (prête), `printing` (impression en
  cours), `stopped` (arrêtée), avec la raison quand l'imprimante la fournit
  (`stopped (media-empty)` = plus de papier). L'état est rafraîchi **chaque
  minute**, indépendamment de l'intervalle réglé pour les niveaux : une
  impression ne dure que quelques secondes.

> Si votre imprimante affiche en permanence `idle`, c'est le plus souvent
> normal : c'est l'état d'une imprimante allumée qui n'a rien à faire. Il ne
> change que pendant une impression ou en cas de problème (plus de papier,
> bourrage). Le bouton « Tester une imprimante » vous montre en direct ce que
> la vôtre annonce à un instant donné.

## Compatibilité

Toute imprimante réseau compatible **AirPrint / IPP Everywhere** (l'immense
majorité des imprimantes vendues depuis ~2012 : HP, Epson, Canon, Brother,
Lexmark…). L'imprimante doit être sur le même réseau que Gladys, avec IPP
activé (il l'est par défaut ; certains menus l'appellent « AirPrint »).

Certaines imprimantes n'annoncent pas leurs niveaux d'encre via IPP : dans ce
cas l'appareil n'expose que son état.

## Configuration

1. Installez l'intégration : les imprimantes annonçant IPP en mDNS sont
   découvertes automatiquement et apparaissent dans l'onglet **Découverte**.
2. Si une imprimante n'est pas trouvée (mDNS bloqué, autre sous-réseau…),
   ajoutez-la dans **Imprimantes (liste manuelle)** : une IP
   (`192.168.1.20`), un nom d'hôte (`imprimante.local`) ou une URI complète
   (`ipp://192.168.1.20/ipp/print`), séparés par des virgules.
3. Ajustez au besoin l'**intervalle de rafraîchissement** (900 s par défaut —
   les niveaux d'encre évoluent lentement). Il ne concerne que les niveaux :
   l'état est toujours relevé chaque minute.
4. Ajoutez les appareils découverts depuis l'onglet **Découverte**.

> Conseil : attribuez une IP fixe (réservation DHCP) aux imprimantes dont
> l'identifiant unique (UUID) n'est pas annoncé — l'intégration se rabat
> alors sur le nom d'hôte pour les identifier.

## Actions

- **Tester une imprimante** — saisissez une IP, un nom d'hôte ou une URI
  `ipp://` : l'intégration l'interroge en direct et affiche le modèle, l'état
  et les niveaux détectés. Le moyen le plus rapide de vérifier une adresse
  avant de l'ajouter à la liste manuelle.

## Dépannage

- **L'imprimante n'est pas découverte** : vérifiez qu'elle répond en IPP avec
  l'action « Tester une imprimante ». Si le test échoue, vérifiez que le
  port 631 est ouvert et qu'IPP/AirPrint est activé dans les réglages de
  l'imprimante.
- **Pas de niveaux d'encre** : l'imprimante ne publie pas les attributs
  `marker-levels` via IPP. C'est une limite du firmware, pas de
  l'intégration.
- **Chemin IPP non standard** : par défaut l'intégration essaie
  `/ipp/print`, `/ipp` puis `/`. Si votre imprimante utilise un autre chemin
  (certaines files CUPS par exemple), saisissez l'URI complète :
  `ipp://hôte:631/le/chemin`.
- Les logs de l'intégration (UI Gladys ou `docker logs`, avec
  `LOG_LEVEL=debug` pour le détail) tracent chaque requête et chaque
  imprimante ignorée.
