# Imprimantes IPP

Cette intégration surveille vos imprimantes réseau via le protocole standard
**IPP** (Internet Printing Protocol) — celui qu'utilise AirPrint. Elle
fonctionne entièrement en local : pas de compte, pas de cloud, pas de clé
d'API. Elle demande Gladys 5.1 ou plus récent.

## Ce que vous obtenez

Un appareil Gladys par imprimante, avec :

- **un capteur par cartouche d'encre ou de toner** (niveau en %), avec
  historique — de quoi tracer la consommation dans le temps et déclencher des
  scènes (« encre noire sous 10 % → notification ») ;
- **l'état de l'imprimante** : `idle` (prête), `printing` (impression en
  cours), `stopped` (arrêtée), avec la raison quand l'imprimante la fournit
  (`stopped (media-empty)` = plus de papier). L'état est surveillé **en
  continu** (échantillonné toutes les 15 s) et mis à jour dès qu'il change,
  indépendamment de l'intervalle réglé pour les niveaux : une impression ne
  dure que quelques secondes.

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

Les imprimantes annoncent leurs niveaux d'encre de trois façons différentes
selon les marques et les firmwares : l'intégration les essaie toutes les
trois (les attributs IPP `marker-*`, la variante `printer-supply`, puis le
protocole SNMP — celui qu'utilise CUPS — quand l'IPP n'annonce rien). Si
aucune ne répond, l'appareil n'expose que son état.

Beaucoup de lasers n'annoncent que leurs toners en IPP, alors que leur table
SNMP liste aussi les pièces d'usure : tambour ou unité d'imagerie, four,
courroie de transfert, récupérateur de toner. L'intégration les y lit en
complément, sans jamais toucher aux cartouches déjà annoncées en IPP. Sur un
appareil déjà ajouté, une pièce apparue ainsi se fait proposer par
« Mettre à jour » dans l'onglet **Découverte**.

## Configuration

1. Installez l'intégration : les imprimantes annonçant IPP en mDNS sont
   découvertes automatiquement et apparaissent dans l'onglet **Découverte**.
2. Si une imprimante n'est pas trouvée (mDNS bloqué, autre sous-réseau…),
   ajoutez-la dans **Imprimantes (liste manuelle)** : une IP
   (`192.168.1.20`), un nom d'hôte (`imprimante.local`) ou une URI complète
   (`ipp://192.168.1.20/ipp/print`), séparés par des virgules.
3. Ajustez au besoin l'**intervalle de rafraîchissement** (900 s par défaut —
   les niveaux d'encre évoluent lentement). Il ne concerne que les niveaux :
   l'état est surveillé en continu (toutes les 15 s).
4. Choisissez au besoin la langue des **noms des capteurs** : par défaut ce
   sont les noms bruts annoncés par l'imprimante (souvent en anglais, du type
   « black cartridge ») ; en sélectionnant Français, les cartouches reconnues
   deviennent « Encre noire », « Toner cyan »… Le réglage s'applique aux
   appareils **nouvellement ajoutés** — pour un appareil existant, renommez
   ses fonctionnalités depuis sa page, ou supprimez-le puis re-ajoutez-le
   (l'historique des anciennes fonctionnalités est alors perdu).
5. Ajoutez les appareils découverts depuis l'onglet **Découverte**.

> Conseil : attribuez une IP fixe (réservation DHCP) aux imprimantes dont
> l'identifiant unique (UUID) n'est pas annoncé — l'intégration se rabat
> alors sur le nom d'hôte pour les identifier.

## Actions

- **Tester une imprimante** — saisissez une IP, un nom d'hôte ou une URI
  `ipp://` : l'intégration l'interroge en direct et affiche le modèle, l'état
  et les niveaux détectés. Le moyen le plus rapide de vérifier une adresse
  avant de l'ajouter à la liste manuelle.

## Widgets du tableau de bord

Avec Gladys 5.1 ou plus récent, l'intégration propose deux widgets dans
l'éditeur de tableau de bord (sous « IPP Printers », le nom de l'intégration).

- **Imprimante** : une imprimante en un coup d'œil — une jauge par
  consommable (encre, toner, tambour…), l'état (prête, impression, arrêtée
  avec sa raison), l'heure du dernier relevé et le consommable le plus bas,
  plus un bouton **Vérifier** qui interroge l'imprimante immédiatement et
  republie ses valeurs. Réglage : l'imprimante à afficher (laissez vide pour
  la première ajoutée à Gladys). Les jauges sont liées aux capteurs de
  l'appareil : elles suivent les niveaux en direct, sans attendre le
  rafraîchissement du widget. Limites : au plus **5 jauges** (le tableau de
  bord limite un widget à 8 éléments) ; au-delà, les niveaux les plus bas
  sont affichés en priorité. Les jauges sont vertes à partir de 25 %, orange
  en dessous, rouges sous 10 %.
- **Consommables** : toutes vos imprimantes en une liste, les plus critiques
  d'abord — pour chacune, l'état et le consommable le plus bas (« Prête ·
  Noir 12 % »), avec la couleur du niveau (rouge sous 10 %, orange sous
  25 %) — et le nombre d'imprimantes « à surveiller » (un consommable sous
  25 %). Aucun réglage. Au plus 10 imprimantes sont listées.

Les deux widgets lisent le dernier relevé fait par l'intégration (toutes les
15 s pour l'état, à l'intervalle réglé pour les niveaux) : ils n'interrogent
jamais l'imprimante eux-mêmes, sauf par le bouton **Vérifier**. Tant qu'une
imprimante n'a pas encore répondu depuis le démarrage de l'intégration, son
état indique « En attente du premier relevé ». Les noms courts des
consommables suivent le réglage **Noms des capteurs** (« Noir », « Cyan »,
« Tambour »… en français ; le nom brut annoncé par l'imprimante sinon).

## Dépannage

- **L'imprimante n'est pas découverte** : vérifiez qu'elle répond en IPP avec
  l'action « Tester une imprimante ». Si le test échoue, vérifiez que le
  port 631 est ouvert et qu'IPP/AirPrint est activé dans les réglages de
  l'imprimante.
- **Pas de niveaux d'encre** : lancez « Tester une imprimante », le message
  précise le cas. « aucun consommable annoncé, ni en IPP ni en SNMP » signifie
  que l'imprimante garde ses niveaux pour son application maison : c'est une
  limite du firmware, pas de l'intégration. Si le SNMP est désactivé dans les
  réglages réseau de l'imprimante, le réactiver suffit parfois à faire
  apparaître les cartouches (le nom de communauté doit rester `public`).
- **Le tambour (ou le four, la courroie…) n'apparaît pas** : ces pièces ne
  sont lues qu'en SNMP. « Tester une imprimante » indique à la fin
  « (+ SNMP : Imaging Unit…) » quand le SNMP en a ajouté ; sinon, vérifiez
  que le SNMP est activé sur l'imprimante (communauté `public`). Une pièce
  déjà annoncée en IPP sous un autre nom n'est jamais ajoutée une seconde
  fois.
- **Une seule cartouche affiche « inconnu » (souvent le noir, sur HP)** : si
  cette cartouche est rechargée ou compatible, c'est voulu par HP — le
  firmware refuse d'estimer le niveau des cartouches non authentiques (il
  affiche « ? » jusque sur l'écran de l'imprimante). La valeur n'existe
  nulle part ; avec une cartouche d'origine, le niveau réapparaît tout seul.
  Le bouton « Tester une imprimante » montre la valeur brute renvoyée
  (« inconnu (-2) »).
- **L'imprimante répond mais en erreur (HTTP 500, HTTP 426)** : fréquent sur
  les firmwares minimalistes (Epson EcoTank notamment). L'intégration essaie
  automatiquement plusieurs variantes de requête (IPP 1.1 puis 2.0, avec puis
  sans liste d'attributs) et bascule d'elle-même en IPP chiffré (`ipps://`)
  quand l'imprimante l'exige (HTTP 426). Si tout échoue, le bouton « Tester
  une imprimante » affiche l'erreur exacte — collez-la sur le forum.
- **Chemin IPP non standard** : par défaut l'intégration essaie
  `/ipp/print`, `/ipp` puis `/`. Si votre imprimante utilise un autre chemin
  (certaines files CUPS par exemple), saisissez l'URI complète :
  `ipp://hôte:631/le/chemin`.
- Les logs de l'intégration (UI Gladys ou `docker logs`, avec
  `LOG_LEVEL=debug` pour le détail) tracent chaque requête et chaque
  imprimante ignorée.
