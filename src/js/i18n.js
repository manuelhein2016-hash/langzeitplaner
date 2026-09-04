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
  // THE ORDER IS LOAD-BEARING, AND IT IS MEASURED (2026-09-04, macOS 26.6.2).
  // Quarantine rides on the .dmg FILE, not on its contents. Mount a downloaded
  // image and nothing inside carries com.apple.quarantine — not the volume, not
  // the .app, not one file inside the bundle. Copy the app off the image and the
  // copy is stamped `0283;…` at copy time. So the app on the DMG and the app in
  // Programme are two different objects as far as Gatekeeper is concerned, and
  // approving the first does not approve the second. Somebody who opens it from
  // the DMG window may see it simply work, drag it across afterwards, and meet
  // the wall a second time on a copy she thinks she has already unlocked. One
  // sentence prevents that, so it is here rather than in a support call.
  unlockTitle: 'macOS fragt beim ersten Start einmal nach',
  unlockLead:
    'Das ist normal. Die App kommt nicht aus dem App Store, deshalb möchte der Mac eine Bestätigung. '
    + 'Zwei Schritte, dann öffnet sie sich — und danach ohne Nachfrage. '
    + 'Wichtig ist dabei nur die Reihenfolge: erst das Symbol in den Ordner „Programme“ ziehen, '
    + 'dann von dort öffnen. Wer die App direkt im Fenster der geladenen Datei startet, '
    + 'muss die Freigabe später noch einmal machen.',

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
  // The second sentence covers the wording nobody here could reproduce without a
  // real download, and it is cheap insurance. Under decision D1 the bundle is
  // ad-hoc signed: `codesign --verify` says "valid on disk, satisfies its
  // Designated Requirement", and `syspolicy_check distribution` says "Adhoc
  // Signed App — Warning" plus "Notary Ticket Missing — Fatal" (both measured
  // 2026-09-04). A quarantined ad-hoc bundle can present as „ist beschädigt und
  // kann nicht geöffnet werden“ with a Papierkorb button and sometimes no
  // „Dennoch öffnen“ at all. The cost of naming it is one sentence. The cost of
  // not naming it is her putting the app in the Papierkorb, which is the one
  // outcome this whole screen exists to prevent.
  unlockNote:
    'Kein „Dennoch öffnen“ zu sehen? Der Knopf erscheint nur kurz nach einem Startversuch. '
    + 'Die App noch einmal öffnen und dann gleich wieder in den Einstellungen nachsehen. '
    + 'Und falls der Mac stattdessen sagt, die App sei „beschädigt“: sie ist es nicht. '
    + 'Das ist dieselbe Sperre mit anderen Worten. Bitte nicht in den Papierkorb legen — '
    + 'der Weg über Datenschutz & Sicherheit ist derselbe.',
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
  // ── F19 · dieser Mac und der Server (19.4) ──────────────────────────────────
  //
  // DIESER ABSCHNITT IST NICHT DER FAMILIENKREIS. Er war es einmal — als es
  // noch keinen gab und „Familienkreis“ die einzige Tür ins Netz war. Seit
  // LZP-601 gibt es den echten Kreis (F15), und zwei Abschnitte mit derselben
  // Überschrift in einem Blatt sind keine Doppelung, sondern eine falsche
  // Auskunft: hier stehen die Adresse des Servers und der PRIVATE Raum dieses
  // Macs (19.4), also das, was nur mit den eigenen Geräten geteilt wird.
  familySectionTitle: 'Server & eigene Geräte',
  familyRelay: 'Server',
  familySpace: 'Privater Raum',
  familyCreate: 'Einrichten',
  familyNeedRelay: 'Bitte zuerst die Adresse des Servers eintragen.',
  familyCreated: 'Eingerichtet. Das Fenster lädt neu.',
  familyFailed: (why) => `Das hat nicht geklappt: ${why}`,
  familyThisMac: (short) => `Dieser Mac: ${short}`,
  familySectionHint:
    'Ohne diesen Schritt bleibt alles auf diesem Mac und es geht nichts ins Netz. '
    + 'Danach liegt dein Board verschlüsselt auf dem Server — lesen kann es nur, wer deine Schlüssel hat.',
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

  // ── F15 / F20 · 15.1–15.4, 20.5, 20.6 — Familienkreis (LZP-601/602) ───────
  //
  // DIE STIMME DIESER BLÖCKE. Der Beitritts-Bildschirm ist das erste, was ein
  // Mensch von diesem Produkt sieht, der es sich nicht ausgesucht hat. Also:
  // kurze Sätze, keine Fachwörter, kein Ausrufezeichen, nichts, was zweimal
  // gelesen werden muss. „Verschlüsselung“ kommt genau einmal vor — in 20.5,
  // wo es der Grund für eine Zusage ist und nicht eine Eigenschaft.
  //
  // WAS HIER NICHT STEHEN DARF (PO-Entscheidung D9, vier Punkte):
  // kein „Fehler“, kein „erneut versuchen“, kein „bitte warten“, und niemals
  // die Aufforderung, jemanden zu bitten, seinen Mac aufzuklappen.
  circleKicker: 'Familienkreis',
  circleSectionTitle: 'Familienkreis',
  circleCreateBtn: 'Familienkreis erstellen',
  circleJoinBtn: 'Einladungscode eingeben',
  circleSectionHint:
    'Ein gemeinsamer Kalender für die Familie. Solange du hier nichts einrichtest, bleibt '
    + 'alles so, wie es ist — dieser Mac arbeitet weiter für sich allein.',
  circleOneOnly: 'Du gehörst zu genau einem Familienkreis.',
  circleMemberOf: (name) => `Du bist in „${name}“.`,
  circleMemberOfUnnamed: 'Du bist in einem Familienkreis.',
  circleYouAdmin: 'Du verwaltest diesen Kreis.',
  circleYouMember: 'Du bist Mitglied.',
  circleNewInvite: 'Neuen Einladungscode erzeugen',
  circleNewInviteCopied: (code) => `Neuer Code: ${code} — Einladung ist kopiert.`,
  circleErrAlready:
    'Du bist schon in einem Familienkreis. Mehr als einen gibt es in dieser Version nicht.',

  // — erstellen (15.2, 20.6, Lieferobjekt 14) —
  circleCreateTitle: 'Einen Familienkreis einrichten',
  circleCreateLead:
    'Du gibst dem Kreis einen Namen und bekommst einen Einladungscode. Den schickst du an die '
    + 'Person, die dazukommen soll. Mehr ist nicht zu tun.',
  circleAdminFraming:
    'Du verwaltest den Kreis: einladen, jemanden entfernen, den Kreis wieder auflösen. Was die '
    + 'anderen für sich behalten, siehst du nicht — auch als Verwalter nicht. Das ist keine '
    + 'Einstellung, die sich ändern ließe, sondern die Verschlüsselung selbst.',
  circleRelayLabel: 'Server',
  circleRelayHint:
    'Die Adresse, über die eure Macs sich abgleichen. Der Server sieht nur verschlüsselte '
    + 'Daten — lesen kann er sie nicht.',
  circleNameLabel: 'Name des Familienkreises',
  circleNamePlaceholder: 'Familie Weber',
  circleYourNameLabel: 'Dein Name',
  circleYourNamePlaceholder: 'Papa',
  circleColorLabel: 'Deine Farbe',
  circleColorTaken: 'schon vergeben',
  circleCreateSubmit: 'Familienkreis erstellen',
  circleCreateFoot:
    'Auf deinem Board ändert sich dadurch nichts. Alles, was du bisher eingetragen hast, '
    + 'bleibt privat, bis du einen Eintrag ausdrücklich teilst.',
  circleNeedName: 'Der Kreis braucht noch einen Namen.',
  circleNeedYourName: 'Wie sollen dich die anderen sehen?',
  circleCreatedTitle: (name) => (name ? `„${name}“ ist eingerichtet.` : 'Der Familienkreis ist eingerichtet.'),
  circleCreatedLead: 'Du verwaltest diesen Kreis.',
  circleCodeLabel: 'Einladungscode',
  circleCodeTtl: (days) =>
    `Der Code gilt ${days} Tage und lässt sich genau einmal einlösen.`,
  circleCodeShare:
    'Schick ihn an die Person, die dazukommen soll — per Mail, per Nachricht, oder sag ihn '
    + 'am Telefon. Im Code stecken keine Schlüssel: Wer ihn liest, kann nichts lesen.',
  circleCopyInvite: 'Einladung kopieren',
  circleCopied: 'Kopiert.',
  circleCopyFailed: 'Kopieren ging nicht — der Code steht oben.',
  circleNoCodeYet:
    'Der Kreis steht. Den Einladungscode kannst du in den Einstellungen erzeugen.',
  circleCreatedD9:
    'Wer beitritt, ist sofort im Kreis. Die gemeinsamen Einträge bekommt er, sobald dein Mac '
    + 'das nächste Mal abgleicht — dafür musst du nichts tun.',
  circleDone: 'Fertig',
  circleWorking: 'Einen Moment',
  circleInviteLine1: (name) => `Du bist zu „${name}“ eingeladen.`,
  circleInviteLine2:
    'In LangzeitPlaner: Einstellungen → Familienkreis → „Einladungscode eingeben“, '
    + 'und beides oben einfügen.',

  // — beitreten (15.3, Lieferobjekt 15) —
  circleJoinTitle: 'Einem Familienkreis beitreten',
  circleJoinLead:
    'Code einfügen, Namen und Farbe wählen, fertig. Kein Konto, kein Passwort, keine Anmeldung.',
  circleCodeInputLabel: 'Einladungscode',
  circleCodePlaceholder: 'XXXX-XXXX-XXXX',
  circleCodeFromPaste: (origin) => `Server aus der Einladung übernommen: ${origin}`,
  circleJoinNamePlaceholder: 'Mama',
  circleJoinSubmit: 'Beitreten',
  circleJoinFoot:
    'Deine Einträge bleiben deine. Beim Beitritt wird nichts geteilt — was die anderen sehen, '
    + 'entscheidest du später Eintrag für Eintrag.',
  circleNeedCode: 'Der Code ist noch nicht vollständig — es sind zwölf Zeichen.',
  circleNeedRelayForJoin:
    'In der Einladung stand auch eine Serveradresse. Füge sie mit ein oder trag sie unten ein.',
  circleColorTakenSwap: (name) =>
    `Diese Farbe hat schon jemand im Kreis. ${name} ist frei — nimmst du die?`,

  // — der Wartezustand (D9, Lieferobjekte 15 und 25) —
  circleJoinedTitle: 'Du bist dabei.',
  circleJoinedLead: 'Du gehörst jetzt zum Familienkreis.',
  circleJoinedMembers: (n) =>
    n === 1
      ? 'Du bist die erste Person im Kreis.'
      : `${n} Mitglieder. Die Namen erscheinen zusammen mit den Einträgen.`,
  circleMemberUnnamed: 'Mitglied',
  circleYou: 'du',
  // DIE EINE ZEILE. Sie sagt, dass es passiert, nicht dass gewartet wird — und
  // sie nennt „ein anderer Mac“, nicht eine Person: ADR 002 §7.1 Schritt 4 sagt
  // ausdrücklich *irgendein* Gerät eines Mitglieds, nicht das des Verwalters.
  circleWaiting:
    'Die gemeinsamen Einträge erscheinen von selbst, sobald ein anderer Mac im Kreis das '
    + 'nächste Mal abgleicht.',
  circleWaitingCalm:
    'Bis dahin bleibt dein Board genau so, wie es ist. Du musst nichts tun und niemanden fragen.',
  circleKeysHere: 'Die gemeinsamen Einträge sind da.',
  circleJoinedPrivacy:
    'Deine eigenen Einträge bleiben privat. Der Beitritt hat daran nichts geändert, und auch '
    + 'der Verwalter kann sie nicht sehen.',

  // — was schiefgehen kann, in ganzen Sätzen —
  circleErrInviteInvalid:
    'Dieser Code passt nicht. Vielleicht ist ein Zeichen vertippt — oder er ist älter als '
    + 'sieben Tage. Lass dir am besten einen neuen schicken.',
  circleErrInviteUsed:
    'Dieser Code ist schon eingelöst. Jeder Code gilt genau einmal; ein neuer ist schnell '
    + 'gemacht.',
  circleErrTooMany:
    'Das waren zu viele Versuche in kurzer Zeit. In einer Stunde geht es wieder.',
  // Zwei Ursachen, ein Satz: der Mac gleicht schon eigene Geräte ab (19.4), ODER er war
  // einmal in einem Kreis und ist ausgetreten — sein Geräte-Eintrag bleibt auf dem Server
  // bestehen. Für die Person davor ist das dasselbe Ereignis, und der Satz darf keine der
  // beiden Ursachen behaupten, die gerade nicht zutrifft.
  circleErrDeviceRegistered:
    'Dieser Mac ist auf diesem Server schon eingetragen — aus einem früheren Kreis oder vom '
    + 'Abgleich der eigenen Geräte. Ein zweites Mal geht es auf diesem Server zurzeit nicht.',
  circleErrMemberExists: 'Dieser Mac gehört schon zu diesem Kreis.',
  circleErrOffline:
    'Keine Verbindung zum Server. Dein Board bleibt unverändert; später geht es weiter.',
  circleErrNoKeystore:
    'Auf diesem Mac lassen sich keine Schlüssel dauerhaft ablegen. Ohne das wäre der '
    + 'Familienkreis nach dem nächsten Beenden weg.',

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

  // ── ADR 004 §4.3's own row: `belegt`, `geteilt`, `privat`, `vonMember`, `geaendert`, `neu`,
  //    in BOTH tables. Glossary §13 is the source; `family/sharing.js:TXT` holds the SENTENCES
  //    (§7.4's two required strings among them) and this holds the WORDS, because a level's key
  //    is `core/entities.js:VISIBILITY_LEVELS` and there is one spelling of each.
  //    `board.js:FAMILY_COPY` is the interim table that steps aside the moment these exist:
  //    `board.js:ft()` resolves through `t()` FIRST and falls back only while a key is missing.
  belegt: 'Belegt',
  geteilt: 'Geteilt',
  privat: 'Privat',
  /** 17.6 — attribution shows WHO and WHEN, never WHAT. `%s` is the member's display name. */
  vonMember: 'von %s',
  geaendert: 'geändert',
  /** 17.5 — the quiet dot. A downgrade NEVER dots (Principle 9, ADR 004 §7 rule 2). */
  neu: 'neu',
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
  // See the German twin above for the measurement behind the ordering sentence.
  unlockTitle: 'macOS asks once, on the first launch',
  unlockLead:
    'This is normal. The app does not come from the App Store, so your Mac wants a confirmation. '
    + 'Two steps, and it opens — and after that it will not ask again. '
    + 'Only the order matters: drag the icon into the “Applications” folder first, '
    + 'then open it from there. If you start it inside the window of the downloaded file, '
    + 'you will have to do the approval a second time later on.',

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
    + 'Open the app once more, then look in Settings again straight away. '
    + 'And if your Mac says instead that the app is “damaged”: it is not. '
    + 'That is the same block in different words. Please do not move it to the Trash — '
    + 'the route through Privacy & Security is the same.',
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
  // ── F19 · this Mac and the server (19.4) ────────────────────────────────────
  // NOT the family circle — see the German block. This is the relay address and
  // this Mac's own PRIVATE space, the one shared only with my own devices.
  familySectionTitle: 'Server & my own devices',
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

  // ── F15 / F20 · 15.1–15.4, 20.5, 20.6 — family circle (LZP-601/602) ───────
  // German is the original here; this is a translation and not a second draft.
  // Where the German is shorter than English wants to be, the English is kept
  // short too — the join screen is read by someone who did not ask for it.
  circleKicker: 'Family circle',
  circleSectionTitle: 'Family circle',
  circleCreateBtn: 'Create a family circle',
  circleJoinBtn: 'Enter an invite code',
  circleSectionHint:
    'A shared calendar for the family. Until you set something up here nothing changes — '
    + 'this Mac carries on working on its own.',
  circleOneOnly: 'You belong to exactly one family circle.',
  circleMemberOf: (name) => `You are in “${name}”.`,
  circleMemberOfUnnamed: 'You are in a family circle.',
  circleYouAdmin: 'You manage this circle.',
  circleYouMember: 'You are a member.',
  circleNewInvite: 'Create a new invite code',
  circleNewInviteCopied: (code) => `New code: ${code} — the invitation is on your clipboard.`,
  circleErrAlready:
    'You are already in a family circle. This version has room for exactly one.',

  // — create (15.2, 20.6, deliverable 14) —
  circleCreateTitle: 'Set up a family circle',
  circleCreateLead:
    'Give the circle a name and you get an invite code. Send it to whoever should join. '
    + 'That is all there is to it.',
  circleAdminFraming:
    'You manage the circle: invite people, remove someone, dissolve it again. What the others '
    + 'keep to themselves you cannot see — not as the admin either. That is not a setting that '
    + 'could be changed; it is the encryption itself.',
  circleRelayLabel: 'Server',
  circleRelayHint:
    'The address your Macs sync through. The server only ever sees encrypted data — it cannot '
    + 'read any of it.',
  circleNameLabel: 'Name of the family circle',
  circleNamePlaceholder: 'The Webers',
  circleYourNameLabel: 'Your name',
  circleYourNamePlaceholder: 'Dad',
  circleColorLabel: 'Your colour',
  circleColorTaken: 'already taken',
  circleCreateSubmit: 'Create the circle',
  circleCreateFoot:
    'Nothing on your board changes. Everything you have written stays private until you share '
    + 'an entry on purpose.',
  circleNeedName: 'The circle still needs a name.',
  circleNeedYourName: 'How should the others see you?',
  circleCreatedTitle: (name) => (name ? `“${name}” is set up.` : 'The family circle is set up.'),
  circleCreatedLead: 'You manage this circle.',
  circleCodeLabel: 'Invite code',
  circleCodeTtl: (days) => `The code is valid for ${days} days and can be used exactly once.`,
  circleCodeShare:
    'Send it to whoever should join — by mail, by message, or read it out on the phone. There '
    + 'are no keys in the code: whoever reads it cannot read anything.',
  circleCopyInvite: 'Copy the invitation',
  circleCopied: 'Copied.',
  circleCopyFailed: 'Copying did not work — the code is above.',
  circleNoCodeYet: 'The circle exists. You can create the invite code in settings.',
  circleCreatedD9:
    'Whoever joins is in the circle straight away. The shared entries reach them the next time '
    + 'your Mac syncs — you do not have to do anything.',
  circleDone: 'Done',
  circleWorking: 'One moment',
  circleInviteLine1: (name) => `You are invited to “${name}”.`,
  circleInviteLine2:
    'In LangzeitPlaner: Settings → Family circle → “Enter an invite code”, and paste both of '
    + 'the lines above.',

  // — join (15.3, deliverable 15) —
  circleJoinTitle: 'Join a family circle',
  circleJoinLead:
    'Paste the code, pick a name and a colour, done. No account, no password, no sign-up.',
  circleCodeInputLabel: 'Invite code',
  circleCodePlaceholder: 'XXXX-XXXX-XXXX',
  circleCodeFromPaste: (origin) => `Server taken from the invitation: ${origin}`,
  circleJoinNamePlaceholder: 'Mom',
  circleJoinSubmit: 'Join',
  circleJoinFoot:
    'Your entries stay yours. Joining shares nothing — what the others see is something you '
    + 'decide later, entry by entry.',
  circleNeedCode: 'The code is not complete yet — it is twelve characters.',
  circleNeedRelayForJoin:
    'The invitation also carried a server address. Paste it along with the code, or enter it '
    + 'below.',
  circleColorTakenSwap: (name) =>
    `Someone in the circle already has that colour. ${name} is free — shall we take it?`,

  // — the waiting state (D9, deliverables 15 and 25) —
  circleJoinedTitle: 'You are in.',
  circleJoinedLead: 'You now belong to the family circle.',
  circleJoinedMembers: (n) =>
    n === 1
      ? 'You are the first person in the circle.'
      : `${n} members. Their names appear together with the entries.`,
  circleMemberUnnamed: 'Member',
  circleYou: 'you',
  circleWaiting:
    'The shared entries appear by themselves, the next time another Mac in the circle syncs.',
  circleWaitingCalm:
    'Until then your board stays exactly as it is. There is nothing to do and nobody to ask.',
  circleKeysHere: 'The shared entries are here.',
  circleJoinedPrivacy:
    'Your own entries stay private. Joining changed nothing about that, and the admin cannot '
    + 'see them either.',

  // — what can go wrong, in whole sentences —
  circleErrInviteInvalid:
    'That code does not match. Perhaps a character is mistyped — or it is more than seven days '
    + 'old. Best to ask for a new one.',
  circleErrInviteUsed:
    'That code has already been used. Every code works exactly once; a new one is quick to make.',
  circleErrTooMany: 'That was too many attempts in a short time. It works again in an hour.',
  circleErrDeviceRegistered:
    'This Mac is already registered on that server — from an earlier circle, or from syncing '
    + 'your own devices. For now it cannot be set up there a second time.',
  circleErrMemberExists: 'This Mac already belongs to that circle.',
  circleErrOffline:
    'No connection to the server. Your board is unchanged; it carries on later.',
  circleErrNoKeystore:
    'This Mac cannot store keys durably. Without that the family circle would be gone the next '
    + 'time you quit.',

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

  // ADR 004 §4.3, the English half. `EN` spreads `DE`, so a key added above and NOT overridden
  // here ships German text to an English board — which is why all six are restated.
  belegt: 'Busy',
  geteilt: 'Shared',
  privat: 'Private',
  vonMember: 'from %s',
  geaendert: 'changed',
  neu: 'new',
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
