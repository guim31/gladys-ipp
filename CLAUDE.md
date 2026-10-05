# CLAUDE.md — IPP Printers

Niveaux d'encre/toner et état de vos imprimantes réseau via IPP (AirPrint). Local, sans cloud.

Intégration externe pour [Gladys Assistant](https://gladysassistant.com), bâtie sur le template officiel `GladysAssistant/integration-template-js` (SDK `@gladysassistant/integration-sdk` ^0.12.0, `gladys_version` `>=4.86.0`). Mainteneur : Guilhem (`guim31`).

Ce fichier rassemble ce qu'une session de code doit savoir et qui ne se lit pas dans le code : choix de conception, faits vérifiés en réel, pièges déjà payés. Le compléter quand un nouveau piège est découvert.

## État au 05/10/2026

Version 1.0.10 publiée, indexée dans le store (SDK 0.12, Gladys ≥ 4.86, sans widget). La branche
`feat/dashboard-widgets` passe au SDK ^0.14.0 et à `gladys_version >=5.1.0` pour ajouter deux
widgets de tableau de bord, `printer` et `supplies` : une fois publiée, la version suivante ne
sera plus proposée aux cœurs plus anciens. Rien n'a encore été vu sur une instance réelle : les
widgets attendent le test de Guilhem ou des testeurs du forum.

## Notes de conception

- **Identifiants** : `gladys.externalIds('printer', platformId)` donne
  `ext:<sélecteur>:printer:<uuid|host-...>` et chaque fonctionnalité `<appareil>:<clé>`, avec
  `state` et `marker:<slug du nom brut>` comme clés. Les widgets reconstruisent l'id d'une jauge
  par `${device.external_id}:marker:${marker.key}` (`markerFeatureId`) et ne la **lient** que si
  l'appareil créé porte cette fonctionnalité ; sinon la jauge est inline (consommable apparu
  depuis l'ajout, avant « Mettre à jour »).
- **Cache des relevés** (`rememberPrinterSnapshot` / `getPrinterSnapshot` dans `device.js`) :
  alimenté par chaque échantillon réussi de `pollPrinter`, publié ou non, avec la date. Un
  échantillon d'état seul (IPP sans repli SNMP) conserve les consommables du dernier relevé de
  niveaux : une imprimante SNMP-only n'annonce rien en IPP et perdrait ses jauges sinon. Le rendu
  d'un widget ne fait **aucune requête** IPP/SNMP ; seul le bouton « Vérifier » interroge
  (`pollPrinter({ force: true })`), et le cœur recharge le widget à la résolution de l'action.
- `pollPrinter` renvoie `{ published, stateChanged, withLevels }` : `index.js` envoie
  `requestWidgetRefresh` aux deux widgets quand un état a changé (les jauges liées suivent les
  états toutes seules, mais les lignes d'état et la liste des consommables sont en cache côté
  cœur jusqu'à `ttl_seconds` = 300).
- **Budget des widgets** : 8 composants au total. Avec l'en-tête, la liste `status` et le bouton,
  il ne reste que **5 jauges** au widget `printer` (le brief en demandait 6 : impossible sans
  perdre l'en-tête ou le bouton). Au-delà de 5 niveaux connus, les plus bas passent d'abord.
- **Couleurs d'état** : `cleanStateReasons` retire la sévérité des `printer-state-reasons`
  (`-error`, `-warning`, `-report`), on ne peut donc pas distinguer une erreur d'un avertissement
  au rendu. Règle retenue : `stopped` → `danger`, `printing` → `info`, `idle` sans raison →
  `success`, `idle` avec raison → `warning`, inconnu → `neutral`. Jamais de style ni de couleur
  `primary` (invisible en mode sombre), un test le vérifie.
- **Noms courts** (`shortMarkerName`, `naming.js`) pour les libellés de jauge (≤ 24) : la couleur
  seule pour une cartouche (« Noir », « Cyan »), la pièce sinon (« Tambour noir », « Four »,
  « Récupérateur ») ; en mode `printer` le nom brut, débarrassé d'un suffixe de numéro de série
  et coupé à 24. `displayMarkerName` (noms des fonctionnalités) n'a pas été touché : il nomme
  encore « Encre noire » un tambour noir, à corriger un jour pour les appareils neufs seulement
  (les noms sont figés à la création).
- « Première imprimante créée » (réglage `printer` vide) = la première du cache `printerDevices`,
  dans l'ordre que renvoie `gladys.getDevices()` ; un cache vide est relu une fois au rendu.
- Le widget `supplies` n'a pas de réglage ; il liste au plus 10 imprimantes (limite des lignes
  `status`), les niveaux connus croissants, puis les imprimantes sans niveau, puis celles jamais
  relevées.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test` (`node --test`). Prettier contrôle **aussi le Markdown** : lancer `npm run format`
  après avoir modifié ce fichier ou le README, sinon la CI tombe.
- La CI tourne en Node 24. Une session cloud a Node 22 par défaut, ce qui suffit (`engines` :
  `>=20`).
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel passe par
  Guilhem ou par les testeurs du forum. Le dire, plutôt que de conclure que « ça marche ».
- **Publier est un geste de Guilhem** : Actions → Release (patch, minor ou major) construit
  l'image `ghcr.io/guim31/<dépôt>`, monte la version du manifeste et pose le tag. Un correctif
  poussé sur `main` sans Release n'atteint aucune installation : le signaler.
- Le workflow Release réindente le manifeste sans relancer la CI : passer `npm run format` au
  commit suivant.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys (communs aux intégrations de guim31)

Vérifiés dans le code du cœur ou payés sur une intégration publiée. Ils valent pour toutes.

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe (1000, 2000, 10000, 15000, 30000, 60000 ms).
  Publier seulement `poll_frequency` donne un appareil accepté mais jamais interrogé. Pour une
  cadence hors liste, publier `should_poll: false` et pousser les états depuis le conteneur, en
  gardant un `onPoll` de repli.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié (`getDeviceFeatureName` du front).
- Depuis Gladys 4.84, un changement de structure fait proposer « Mettre à jour » dans l'onglet
  Découverte (`structure_changed`) : plus besoin de supprimer et recréer l'appareil. Un
  changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language`. Le superviseur injecte `TZ`, le
  fuseau de Gladys, dans le conteneur. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus en `<input type="number" min max>` **sans `step`** (le
  manifeste n'en accepte pas) : le navigateur n'accepte alors que `min + k`. Min et défaut
  **entiers** seulement ; une valeur décimale passe par un `select` ou par un `string` parsé
  (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir (la saisie
  s'efface à chaque frappe), et une action n'applique **aucun `default`**, ni à l'affichage ni
  côté serveur, tout en exigeant les champs `required` (422).

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- Budget du cœur : **8 composants par widget, dont 2 textes au plus**. Le validateur du SDK le
  signale ; `validateWidgetContent` est exporté pour les tests. Les 6 tuiles de la grammaire ne
  tiennent donc jamais avec un en-tête, un `status` et un bouton : compter 5.
- Une jauge `device_feature` prend les bornes de la fonctionnalité ; sa `color` est figée au
  rendu (jusqu'à `ttl_seconds`), seule l'aiguille est vivante.
- `onWidgetGet` reçoit `language` (`fr`, `en`…) mais pas le fuseau : le conteneur a `TZ` du
  superviseur, `Intl.DateTimeFormat` sans option `timeZone` suffit pour une heure locale.
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées, ce que fait
  le bouton dans ses paramètres.
- Le vocabulaire des widgets n'a ni liste ni curseur. Seul un bouton `device_feature` numérique
  a un état actif natif.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil (Kp > 6) reste le travail
  d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- Passer `gladys_version` à `>=5.1.0` coupe les mises à jour des cœurs plus anciens, qui
  refusent les champs inconnus du manifeste.

## Publication et store

- Avant de demander une Release ou le topic, lancer le validateur officiel depuis la racine :
  `npx -y github:GladysAssistant/integration-store`. Il vérifie le schéma, la `description`
  (**100 caractères au plus par langue**), la documentation (300 caractères au moins), l'image
  Docker et la cover (**150 Ko au plus**).
- Le topic `gladys-assistant-integration` fait indexer le dépôt ; Guilhem le pose (le jeton de
  l'agent n'en a pas le droit). L'indexeur passe à H:13 chaque heure, souvent avec une demi-heure
  de retard, et rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  l'index `https://integration-store-storage.gladysassistant.com/index.json`.
- Sans topic, on installe par la carte « Installer depuis GitHub » (URL du dépôt, Gladys ≥ 4.84) :
  le cœur lit le manifeste sur `main` et propose les mises à jour à chaque rafraîchissement du
  catalogue.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi. Avant de pousser un dépôt neuf, tester sur
  un `git clone` propre, pas sur la copie de travail.
