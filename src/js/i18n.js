// German is the default; English is a toggle (spec 13.7). Weekday abbreviations
// stay language-specific (Mo/Di/Mi vs Mo/Tu/We) — German readers expect the
// German pair, English readers stumble over "Mi" for Wednesday.

const DE = {
  appName: 'LangzeitPlaner',
  today: 'Heute',
  feiertage: 'Feiertage',
  schulferien: 'Schulferien',
  categories: 'Kategorien',
  find: 'Suchen',
  print: 'Drucken',
  settings: 'Einstellungen',
  export: 'Exportieren',
  import: 'Importieren',
  scratchpad: 'Notizzettel',
  edit: 'bearbeiten',
  done: 'Fertig',
  cancel: 'Abbrechen',
  save: 'Sichern',
  delete: 'Löschen',
  close: 'Schließen',
  addNote: '＋ Notiz hinzufügen',
  entries: 'Einträge',
  entry: 'Eintrag',
  barsHere: 'Balken an diesem Tag',
  continues: 'läuft weiter →',
  layers: 'Ebenen',
  mode: 'Modus',
  rolling: 'Rollierend',
  pinned: 'Fixiert',
  repeatsYearly: 'Jährlich wiederholen',
  noResults: 'keine Treffer',
  ofHits: 'von',
  language: 'Sprache',
  bundesland: 'Bundesland',
  bundeslandNone: 'Kein Bundesland gewählt',
  pickBundesland: 'Bundesland wählen',
  ferienHorizon: 'Ferien-Daten bis',
  ferienUnverified:
    'Achtung: Platzhalterdaten. Vor Release durch die offiziellen KMK-Termine ersetzen.',
  launchAtLogin: 'Beim Anmelden starten',
  menuBarIcon: 'Symbol in der Menüleiste',
  rowHeight: 'Zeilenhöhe',
  colWidth: 'Spaltenbreite',
  paper: 'Papierformat',
  snapshots: 'Sicherungen',
  restore: 'Wiederherstellen',
  noSnapshots: 'Noch keine Sicherungen',
  newCategory: 'Neue Kategorie',
  renameCategory: 'Umbenennen',
  deleteCategory: 'Kategorie löschen',
  reassignTitle: 'Kategorie löschen',
  reassignBody: (n, name) =>
    `„${name}“ hat ${n} ${n === 1 ? 'Eintrag' : 'Einträge'}. Wohin damit?`,
  reassignTo: 'Einträge verschieben nach',
  importConfirm: 'Aktuelles Board ersetzen?',
  importBody:
    'Der Import überschreibt alle Einträge, Kategorien und Einstellungen. Das lässt sich nicht widerrufen — aber die Sicherung von heute bleibt erhalten.',
  restoreConfirm: 'Sicherung wiederherstellen?',
  restoreBody: (d) => `Das Board wird auf den Stand von ${d} zurückgesetzt.`,
  replace: 'Ersetzen',
  firstRunTitle: 'Willkommen',
  firstRunBody:
    'Klicke auf einen Tag und tippe los. Ziehe senkrecht, um einen Balken zu legen.',
  firstRunState:
    'Für Feiertage und Schulferien fehlt noch dein Bundesland.',
  emptyHint: 'Klicken und tippen',
  showOtherStates: 'Andere Bundesländer gedimmt',
  ferienPattern: 'Ferien schraffieren',
  ferienPatternHint: 'Zweiter Kanal neben der Helligkeit — hilft auf schwachen Displays und im Druck.',
  // A12 supersedes the v1 note that lived here: macOS 15 removed the
  // right-click → Öffnen bypass, so teaching it would send people down a road
  // that no longer exists. The whole path now lives in the LZP-106 screen.
  gatekeeper: 'Wenn sich die App nicht öffnet',

  // ── F22 · 22.2 / A12 — the first-run unlock screen (LZP-106) ───────────────
  // The macOS path below is Apple's own, from support.apple.com/de-de/102445:
  // Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen“ → „Öffnen“.
  // Voice: this is someone who was told "it's just a calendar" and has just met
  // a security warning. Calm, short, no jargon, no blame, no exclamation marks.
  unlockTitle: 'macOS fragt beim ersten Start einmal nach',
  unlockLead:
    'Das ist normal. Die App kommt nicht aus dem App Store, deshalb möchte der Mac eine Bestätigung. '
    + 'Zwei Schritte, dann öffnet sie sich — und danach ohne Nachfrage.',

  unlockStep1Title: 'In den Systemeinstellungen freigeben',
  unlockStep1Body:
    'Apple-Menü oben links → Systemeinstellungen → Datenschutz & Sicherheit. '
    + 'Dort ganz nach unten scrollen, bis „Sicherheit“ kommt. Da steht, dass LangzeitPlaner '
    + 'blockiert wurde, und daneben der Knopf „Dennoch öffnen“.',

  unlockStep2Title: 'Das Öffnen bestätigen',
  unlockStep2Body:
    'Der Hinweis kommt noch einmal — diesmal mit einem Knopf „Öffnen“. '
    + 'Danach fragt der Mac nach dem Passwort oder dem Fingerabdruck. Das ist der letzte Schritt.',

  unlockDone: 'Danach ist es erledigt. Bei dieser App fragt macOS nicht wieder.',
  unlockNote:
    'Kein „Dennoch öffnen“ zu sehen? Der Knopf erscheint nur kurz nach einem Startversuch. '
    + 'Die App noch einmal öffnen und dann gleich wieder in den Einstellungen nachsehen.',
  unlockWhy:
    'Warum das kommt: die App ist nicht bei Apple registriert. Am Board ändert das nichts — '
    + 'die Einträge bleiben auf diesem Mac.',
  unlockGotIt: 'Verstanden',

  // Strings drawn INSIDE the two illustrations. They are macOS's words, not
  // ours, so they are kept verbatim and short enough to fit the drawing.
  unlockUiSysprefs: 'Systemeinstellungen',
  unlockUiPaneL1: 'Datenschutz &',
  unlockUiPaneL2: 'Sicherheit',
  unlockUiScroll: 'ganz nach unten',
  unlockUiSecurity: 'SICHERHEIT',
  unlockUiBlocked1: '„LangzeitPlaner“ wurde blockiert,',
  unlockUiBlocked2: 'um deinen Mac zu schützen.',
  unlockUiOpenAnyway: 'Dennoch öffnen',
  unlockUiAlert1: 'Apple konnte nicht überprüfen, ob',
  unlockUiAlert2: '„LangzeitPlaner“ frei von Schadsoftware ist.',
  unlockUiAlert3: 'Diese Software benötigt eine Bestätigung.',
  unlockUiTrash: 'In den Papierkorb',
  unlockUiOpen: 'Öffnen',

  // ── F22 · Updates (LZP-102 / LZP-104) ──────────────────────────────────────
  // Every string here has an English twin below (Gate 7+). The updater module
  // itself is string-free: it returns a key and arguments, and this table is the
  // only place the sentence exists.
  updateAvailable: 'Update verfügbar',
  updateStaged: 'Update bereit — beim nächsten Start aktiv',
  // 22.7 / LZP-104 — ONE plain sentence. No version numbers the user has to
  // decode beyond the one they need, no "protocol", no error code.
  updateRequired: (min) =>
    `Diese Version ist zu alt. Bitte auf Version ${min} oder neuer aktualisieren.`,
  updateCheckFailed: 'Update-Prüfung fehlgeschlagen',
  // 22.6 — a rejected build is not a scary event, but it must not be silent.
  updateSignatureFailed:
    'Update abgelehnt: die Signatur stimmt nicht. Es wurde nichts installiert.',
  updateCheckLabel: 'Nach Updates suchen',
  // The 21.5 disclosure, in one line, on the first-run screen and in settings.
  updateCheckHint:
    'Einmal täglich fragt die App, ob es eine neuere Version gibt. Dabei wird nichts über dich übertragen — dein Board bleibt offline.',
  updateNeverChecked: 'Noch nicht geprüft',
  updateLastChecked: (d) => `Zuletzt geprüft: ${d}`,
  updateCurrentVersion: 'Installierte Version',

  // ── F22 · Update-UX (LZP-103, Story 22.4, Lieferobjekt 26) ─────────────────
  // Der Ton ist Absicht. Ein Update ist die unwichtigste Nachricht, die dieses
  // Programm je hat — kein Ausrufezeichen, kein „jetzt“, kein „wichtig“.
  updates: 'Updates',
  updateAuto: 'Automatisch nach Updates suchen',
  updateCheckNow: 'Jetzt suchen',
  updateChecking: 'Wird geprüft …',
  updateRestart: 'Neu starten',
  // 22.4, die Hälfte, die man leicht vergisst: nichts tun funktioniert auch.
  updateRestartHint:
    'Ein Klick startet gleich in die neue Version. Wer das Programm einfach irgendwann beendet, bekommt sie beim nächsten Start — von selbst.',
  updateOffHint:
    'Die automatische Prüfung ist aus. Von Hand suchen geht weiter jederzeit.',
  updateUnsupported:
    'Updates verwaltet die installierte App. In der Browser-Vorschau gibt es keine.',
  // ── F19 · 19.5 — Gerätekopplung (LZP-503, Lieferobjekt 21) ────────────────
  // Der Ton: es gibt hier kein Passwort und keinen Account. Es gibt einen Code,
  // der drei Minuten gilt, und eine Zahl, die auf beiden Bildschirmen steht.
  // Der einzige Satz, der laut sein darf, ist der über die sechs Ziffern —
  // ADR 002 §6.4: sie sind der einzige Schutz gegen einen MITM, und ein Klick
  // ohne Hinsehen nimmt ihn weg. Kein Ausrufezeichen trotzdem: der Satz trägt
  // sich selbst.
  pairKicker: 'Geräte koppeln',
  // ── F19 · der Familienkreis, die Tür (LZP-505 / A10) ────────────────────────
  familySectionTitle: 'Familienkreis',
  familyRelay: 'Server',
  familySpace: 'Privater Raum',
  familyCreate: 'Einrichten',
  familyNeedRelay: 'Bitte zuerst die Adresse des Servers eintragen.',
  familyCreated: 'Eingerichtet. Das Fenster lädt neu.',
  familyFailed: (why) => `Das hat nicht geklappt: ${why}`,
  familyThisMac: (short) => `Dieser Mac: ${short}`,
  familySectionHint:
    'Ohne diesen Schritt bleibt alles auf diesem Mac und es geht nichts ins Netz. '
    + 'Danach liegt Ihr Board verschlüsselt auf dem Server — lesen kann es nur, wer Ihre Schlüssel hat.',
  pairSectionTitle: 'Meine Geräte',
  pairAddDevice: 'Zweiten Mac hinzufügen',
  pairHaveCode: 'Ich habe einen Code',
  pairSectionHint:
    'Ein zweiter Mac bekommt dein ganzes Board — auch die privaten Einträge — Ende-zu-Ende '
    + 'verschlüsselt. Kein Passwort: ein Code, den du vom einen Mac auf den anderen tippst.',
  pairUnsupported:
    'Koppeln geht in der Browser-Vorschau nicht. In der installierten App ist es hier.',

  pairCodeTitle: 'Diesen Code auf dem neuen Mac eintippen',
  pairCodeLead:
    'Öffne LangzeitPlaner auf dem zweiten Mac, wähle dort „Ich habe einen Code“ und tippe die '
    + 'zwölf Zeichen ein. Groß- und Kleinschreibung ist egal.',
  pairCodeWaiting: 'Dieser Mac wartet, bis der andere sich meldet.',
  pairCodeWhy:
    'Der Code gilt drei Minuten und nur ein einziges Mal. Danach erzeugt dieser Bildschirm '
    + 'einen neuen — es geht dabei nichts verloren.',
  pairCodeExpiresIn: (mmss) => `Noch ${mmss} gültig`,
  pairCodeExpiredNow: 'Der Code ist abgelaufen.',

  pairEnterTitle: 'Code vom ersten Mac eintippen',
  pairEnterLead:
    'Auf dem Mac, der das Board schon hat, steht ein Code aus zwölf Zeichen. Tippe ihn hier ein.',
  pairEnterLabel: 'Kopplungscode',
  pairEnterSubmit: 'Weiter',
  pairEnterWrong: 'Der Code passt nicht.',
  pairAttemptsLeft: (n) => (n === 1 ? 'Noch ein Versuch.' : `Noch ${n} Versuche.`),
  pairEnterWhy:
    'Nach fünf Fehlversuchen ist der Code verbraucht. Dann erzeugt der erste Mac einfach einen '
    + 'neuen — es geht nichts verloren.',

  // Die SAS-Vergleichsseite. „Ja“ ist hier kein Weiter-Knopf, sondern eine
  // Aussage über eine bestimmte Zahl; deshalb steht die Zahl im Knopf.
  pairSasTitle: 'Stimmen die Zahlen überein?',
  pairSasLead:
    'Auf beiden Macs muss jetzt dieselbe sechsstellige Zahl stehen. Sieh auf dem anderen '
    + 'Bildschirm nach, bevor du bestätigst.',
  pairSasWhy:
    'Diese sechs Ziffern sind das Einzige, was verhindert, dass sich jemand zwischen die beiden '
    + 'Macs schiebt. Stimmen sie überein, war niemand dazwischen. Ein Klick ohne Hinsehen nimmt '
    + 'diesen Schutz weg.',
  pairSasSelf: (short) => `Dieser Mac: ${short}`,
  pairSasPeer: (short) => `Anderer Mac: ${short}`,
  pairSasWait: 'Zuerst vergleichen',
  pairSasYes: (digits) => `Ja — auf beiden steht ${digits}`,
  pairSasNo: 'Die Zahlen sind verschieden',
  pairSasUnsure:
    'Unsicher? Abbrechen kostet nichts. Es wird dabei nichts übertragen, und du kannst jederzeit '
    + 'von vorn anfangen.',

  pairWorkingTitle: 'Einen Moment',
  pairWorking: 'Die Schlüssel werden übertragen. Das dauert einen Augenblick.',

  pairDoneTitle: 'Fertig',
  pairDoneExisting:
    'Der zweite Mac gehört jetzt dazu. Ab sofort zeigen beide dasselbe Board — verschlüsselt, '
    + 'ohne dass du etwas tun musst.',
  pairDoneNew:
    'Dieser Mac gehört jetzt dazu. Das Board wird gleich geladen; bei einem vollen Jahr kann '
    + 'das einen Moment dauern.',
  pairDonePeer: (short) => `Gekoppelt mit ${short}.`,

  pairStoppedTitle: 'Abgebrochen',
  pairStoppedRefused:
    'Die Zahlen waren verschieden. Genau dafür ist der Vergleich da: es saß jemand oder etwas '
    + 'dazwischen. Versuch es noch einmal — am besten in einem Netz, dem du traust.',
  pairStoppedExpired: 'Die drei Minuten sind vorbei.',
  pairStoppedBurned:
    'Zu viele Fehlversuche. Dieser Code ist verbraucht. Erzeuge auf dem ersten Mac einen neuen.',
  pairStoppedFailed: 'Der Vorgang wurde abgebrochen.',
  pairStoppedNothing: 'Es wurde nichts übertragen. Beide Macs sind unverändert.',
  pairRestart: 'Neu starten',
  pairCancel: 'Abbrechen',
  pairClose: 'Schließen',

  // ── F19 · 19.3 — Abgleich (LZP-504, Lieferobjekt 20) ──────────────────────
  // Zwei der drei Zustände sind nichts. Was hier steht, sieht nur jemand, der
  // in den Einstellungen nachschaut, oder als Tooltip an einem 6-px-Punkt.
  // Kein Satz darf zum Handeln auffordern: es gibt nichts zu tun.
  syncSectionTitle: 'Abgleich',
  syncHealthy: 'Alles abgeglichen.',
  syncPendingDetail: (n) =>
    n === 1
      ? 'Eine Änderung wartet auf die Verbindung. Sie ist auf diesem Mac gesichert.'
      : `${n} Änderungen warten auf die Verbindung. Sie sind auf diesem Mac gesichert.`,
  syncPendingNone: 'Keine Verbindung. Sobald wieder Netz da ist, geht es von selbst weiter.',
  syncErrOffline:
    'Keine Verbindung zum Netz. Deine Änderungen sind gesichert und gehen los, sobald wieder '
    + 'Netz da ist.',
  syncErrAuth:
    'Dieser Mac darf nicht mehr abgleichen. Wahrscheinlich wurde er aus dem Familienkreis '
    + 'entfernt. Das Board auf diesem Mac bleibt, wie es ist.',
  syncErrProtocol:
    'Diese Version ist zu alt für den Abgleich. Ein Update behebt das; bis dahin funktioniert '
    + 'das Board hier ganz normal weiter.',
  syncErrQuarantine:
    'Eine Änderung ließ sich nicht übertragen und wurde zurückgestellt. Alles andere läuft weiter.',
  syncErrDecrypt:
    'Eine Änderung von einem anderen Gerät ließ sich nicht lesen und wurde übersprungen.',
  syncErrClockSkew:
    'Die Uhr dieses Macs geht deutlich falsch. Der Abgleich braucht die richtige Zeit.',
  syncErrGeneric: 'Der Abgleich steht gerade. Das Board auf diesem Mac funktioniert weiter.',
  syncLastPull: (d) => `Zuletzt abgeglichen: ${d}`,
  syncNever: 'Noch nicht abgeglichen',
  syncSolo: 'Dieser Mac arbeitet allein. Es wird nichts übertragen.',
  syncNoButtonHint:
    'Einen Knopf zum Abgleichen gibt es nicht — das passiert von selbst, im Hintergrund.',

  more: 'weitere',
  lanesFull: 'weitere Balken',
  historyHitsLabel: 'Außerhalb des Zeitraums',
  pinnedToHistory: 'Modus: Fixiert — „Heute“ (⌘T) führt zurück',
  print_generated: 'LangzeitPlaner',
  yearBack: 'Jahr zurück',
  yearFwd: 'Jahr vor',
  density: 'Dichte',
  appearance: 'Darstellung',
  data: 'Daten',
  window: 'Fenster',
  shortcutHint: 'Alle Kürzel: siehe Menüleiste',
  untitledBar: 'Balken',
  hidden: 'ausgeblendet',
};

const EN = {
  ...DE,
  today: 'Today',
  feiertage: 'Public holidays',
  schulferien: 'School holidays',
  categories: 'Categories',
  find: 'Find',
  print: 'Print',
  settings: 'Settings',
  export: 'Export',
  import: 'Import',
  scratchpad: 'Scratchpad',
  edit: 'edit',
  done: 'Done',
  cancel: 'Cancel',
  save: 'Save',
  delete: 'Delete',
  close: 'Close',
  addNote: '＋ Add note',
  entries: 'entries',
  entry: 'entry',
  barsHere: 'Bars on this day',
  continues: 'continues →',
  layers: 'Layers',
  mode: 'Mode',
  rolling: 'Rolling',
  pinned: 'Pinned',
  repeatsYearly: 'Repeats yearly',
  noResults: 'no matches',
  ofHits: 'of',
  language: 'Language',
  bundesland: 'Federal state',
  bundeslandNone: 'No federal state selected',
  pickBundesland: 'Choose a federal state',
  ferienHorizon: 'School-holiday data until',
  ferienUnverified:
    'Warning: placeholder data. Replace with the official KMK dates before release.',
  launchAtLogin: 'Launch at login',
  menuBarIcon: 'Menu-bar icon',
  rowHeight: 'Row height',
  colWidth: 'Column width',
  paper: 'Paper size',
  snapshots: 'Snapshots',
  restore: 'Restore',
  noSnapshots: 'No snapshots yet',
  newCategory: 'New category',
  renameCategory: 'Rename',
  deleteCategory: 'Delete category',
  reassignTitle: 'Delete category',
  reassignBody: (n, name) =>
    `“${name}” has ${n} ${n === 1 ? 'entry' : 'entries'}. Move them where?`,
  reassignTo: 'Move entries to',
  importConfirm: 'Replace current board?',
  importBody:
    'Importing overwrites all entries, categories and settings. This cannot be undone — but today’s snapshot is kept.',
  restoreConfirm: 'Restore snapshot?',
  restoreBody: (d) => `The board will be reset to its state from ${d}.`,
  replace: 'Replace',
  firstRunTitle: 'Welcome',
  firstRunBody:
    'Click a day and start typing. Drag vertically to lay down a bar.',
  firstRunState: 'Public and school holidays need your federal state first.',
  emptyHint: 'Click and type',
  showOtherStates: 'Other states dimmed',
  ferienPattern: 'Hatch school holidays',
  ferienPatternHint: 'A second channel next to brightness — helps on weak displays and in print.',
  gatekeeper: 'If the app will not open',

  // ── F22 · 22.2 / A12 — the first-run unlock screen (LZP-106) ───────────────
  // English path from support.apple.com/en-us/102445:
  // System Settings → Privacy & Security → Open Anyway → Open.
  unlockTitle: 'macOS asks once, on the first launch',
  unlockLead:
    'This is normal. The app does not come from the App Store, so your Mac wants a confirmation. '
    + 'Two steps, and it opens — and after that it will not ask again.',

  unlockStep1Title: 'Allow it in System Settings',
  unlockStep1Body:
    'Apple menu, top left → System Settings → Privacy & Security. '
    + 'Scroll all the way down to “Security”. It says there that LangzeitPlaner was blocked, '
    + 'and next to it is a button, “Open Anyway”.',

  unlockStep2Title: 'Confirm the opening',
  unlockStep2Body:
    'The note comes back once more — this time with an “Open” button. '
    + 'Your Mac then asks for your password or your fingerprint. That is the last step.',

  unlockDone: 'That is all. macOS will not ask again for this app.',
  unlockNote:
    'No “Open Anyway” to be seen? The button only appears shortly after a launch attempt. '
    + 'Open the app once more, then look in Settings again straight away.',
  unlockWhy:
    'Why this happens: the app is not registered with Apple. It changes nothing about the board — '
    + 'the entries stay on this Mac.',
  unlockGotIt: 'Got it',

  unlockUiSysprefs: 'System Settings',
  unlockUiPaneL1: 'Privacy &',
  unlockUiPaneL2: 'Security',
  unlockUiScroll: 'all the way down',
  unlockUiSecurity: 'SECURITY',
  unlockUiBlocked1: '“LangzeitPlaner” was blocked to',
  unlockUiBlocked2: 'protect your Mac.',
  unlockUiOpenAnyway: 'Open Anyway',
  unlockUiAlert1: 'Apple could not verify “LangzeitPlaner”',
  unlockUiAlert2: 'is free of malware.',
  unlockUiAlert3: 'This software needs to be confirmed.',
  unlockUiTrash: 'Move to Trash',
  unlockUiOpen: 'Open',

  // ── F22 · Updates (LZP-102 / LZP-104) ──────────────────────────────────────
  updateAvailable: 'Update available',
  updateStaged: 'Update ready — active on next start',
  updateRequired: (min) =>
    `This version is too old. Please update to version ${min} or newer.`,
  updateCheckFailed: 'Update check failed',
  updateSignatureFailed:
    'Update rejected: the signature does not match. Nothing was installed.',
  updateCheckLabel: 'Check for updates',
  updateCheckHint:
    'Once a day the app asks whether a newer version exists. Nothing about you is transmitted — your board stays offline.',
  updateNeverChecked: 'Not checked yet',
  updateLastChecked: (d) => `Last checked: ${d}`,
  updateCurrentVersion: 'Installed version',

  // ── F22 · update UX (LZP-103, story 22.4, deliverable 26) ──────────────────
  updates: 'Updates',
  updateAuto: 'Check for updates automatically',
  updateCheckNow: 'Check now',
  updateChecking: 'Checking …',
  updateRestart: 'Restart',
  updateRestartHint:
    'One click restarts into the new version right now. Or just quit the app whenever you like — the next start picks it up on its own.',
  updateOffHint:
    'Automatic checking is off. Checking by hand still works at any time.',
  updateUnsupported:
    'Updates are handled by the installed app. There are none in the browser preview.',
  // ── F19 · 19.5 — device pairing (LZP-503, deliverable 21) ─────────────────
  // Same register as the German: no password, no account, no wizard voice. The
  // only sentence allowed any weight is the one about the six digits.
  pairKicker: 'Pair devices',
  // ── F19 · the Familienkreis, the door (LZP-505 / A10) ───────────────────────
  familySectionTitle: 'Family circle',
  familyRelay: 'Server',
  familySpace: 'Private space',
  familyCreate: 'Set up',
  familyNeedRelay: 'Enter the address of the server first.',
  familyCreated: 'Set up. This window will reload.',
  familyFailed: (why) => `That did not work: ${why}`,
  familyThisMac: (short) => `This Mac: ${short}`,
  familySectionHint:
    'Without this step everything stays on this Mac and nothing goes to the network. '
    + 'Afterwards your board is stored encrypted on the server — only someone with your keys can read it.',
  pairSectionTitle: 'My devices',
  pairAddDevice: 'Add a second Mac',
  pairHaveCode: 'I have a code',
  pairSectionHint:
    'A second Mac gets your whole board — private entries included — end-to-end encrypted. '
    + 'No password: a code you read off one Mac and type into the other.',
  pairUnsupported:
    'Pairing does not work in the browser preview. In the installed app it lives here.',

  pairCodeTitle: 'Type this code into the new Mac',
  pairCodeLead:
    'Open LangzeitPlaner on the second Mac, choose “I have a code” there, and type in the twelve '
    + 'characters. Upper or lower case makes no difference.',
  pairCodeWaiting: 'This Mac is waiting for the other one to answer.',
  pairCodeWhy:
    'The code is valid for three minutes and for one attempt only. After that this screen makes '
    + 'a new one — nothing is lost either way.',
  pairCodeExpiresIn: (mmss) => `Valid for another ${mmss}`,
  pairCodeExpiredNow: 'The code has expired.',

  pairEnterTitle: 'Type the code from the first Mac',
  pairEnterLead:
    'The Mac that already has the board is showing a twelve-character code. Type it in here.',
  pairEnterLabel: 'Pairing code',
  pairEnterSubmit: 'Continue',
  pairEnterWrong: 'That code does not match.',
  pairAttemptsLeft: (n) => (n === 1 ? 'One attempt left.' : `${n} attempts left.`),
  pairEnterWhy:
    'After five wrong attempts the code is spent. The first Mac then simply makes a new one — '
    + 'nothing is lost.',

  pairSasTitle: 'Do the numbers match?',
  pairSasLead:
    'Both Macs should now be showing the same six-digit number. Look at the other screen before '
    + 'you confirm.',
  pairSasWhy:
    'These six digits are the only thing stopping someone from sitting between the two Macs. If '
    + 'they match, nobody was in between. Clicking without looking removes that protection.',
  pairSasSelf: (short) => `This Mac: ${short}`,
  pairSasPeer: (short) => `Other Mac: ${short}`,
  pairSasWait: 'Compare them first',
  pairSasYes: (digits) => `Yes — both show ${digits}`,
  pairSasNo: 'The numbers are different',
  pairSasUnsure:
    'Not sure? Cancelling costs nothing. Nothing is transferred, and you can start again at any '
    + 'time.',

  pairWorkingTitle: 'One moment',
  pairWorking: 'The keys are being transferred. This takes a moment.',

  pairDoneTitle: 'Done',
  pairDoneExisting:
    'The second Mac now belongs. From here on both show the same board — encrypted, and without '
    + 'you having to do anything.',
  pairDoneNew:
    'This Mac now belongs. The board is loading; with a full year behind it that can take a '
    + 'moment.',
  pairDonePeer: (short) => `Paired with ${short}.`,

  pairStoppedTitle: 'Stopped',
  pairStoppedRefused:
    'The numbers were different. That is exactly what the comparison is for: something or '
    + 'someone was in between. Try again — ideally on a network you trust.',
  pairStoppedExpired: 'The three minutes are up.',
  pairStoppedBurned:
    'Too many wrong attempts. This code is spent. Make a new one on the first Mac.',
  pairStoppedFailed: 'The process was stopped.',
  pairStoppedNothing: 'Nothing was transferred. Both Macs are unchanged.',
  pairRestart: 'Start again',
  pairCancel: 'Cancel',
  pairClose: 'Close',

  // ── F19 · 19.3 — sync status (LZP-504, deliverable 20) ────────────────────
  syncSectionTitle: 'Sync',
  syncHealthy: 'Everything is in sync.',
  syncPendingDetail: (n) =>
    n === 1
      ? 'One change is waiting for a connection. It is safe on this Mac.'
      : `${n} changes are waiting for a connection. They are safe on this Mac.`,
  syncPendingNone: 'No connection. It picks up again on its own once there is one.',
  syncErrOffline:
    'No network connection. Your changes are safe and will go out as soon as there is one again.',
  syncErrAuth:
    'This Mac is no longer allowed to sync. It was most likely removed from the family circle. '
    + 'The board on this Mac stays exactly as it is.',
  syncErrProtocol:
    'This version is too old to sync. An update fixes it; until then the board here keeps '
    + 'working normally.',
  syncErrQuarantine:
    'One change could not be sent and was set aside. Everything else carries on.',
  syncErrDecrypt: 'A change from another device could not be read and was skipped.',
  syncErrClockSkew:
    'This Mac’s clock is significantly wrong. Syncing needs the right time.',
  syncErrGeneric: 'Syncing has stalled. The board on this Mac keeps working.',
  syncLastPull: (d) => `Last synced: ${d}`,
  syncNever: 'Not synced yet',
  syncSolo: 'This Mac works on its own. Nothing is transmitted.',
  syncNoButtonHint: 'There is no sync button — it happens on its own, in the background.',

  more: 'more',
  lanesFull: 'more bars',
  historyHitsLabel: 'Outside the visible range',
  pinnedToHistory: 'Mode: pinned — “Today” (⌘T) brings you back',
  yearBack: 'Year back',
  yearFwd: 'Year forward',
  density: 'Density',
  appearance: 'Appearance',
  data: 'Data',
  window: 'Window',
  shortcutHint: 'All shortcuts: see the menu bar',
  untitledBar: 'Bar',
  hidden: 'hidden',
};

const TABLES = { de: DE, en: EN };

let current = 'de';

export function setLang(l) {
  current = TABLES[l] ? l : 'de';
}
export function getLang() {
  return current;
}
export function t(key, ...args) {
  const v = TABLES[current][key];
  if (typeof v === 'function') return v(...args);
  return v ?? key;
}
