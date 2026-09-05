// src/js/feedback/copy.js — every word LZP-1009 puts on a screen, German first.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THE COPY IS HERE AND NOT IN `i18n.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `src/js/i18n.js` is the product's shared table and it belongs to nobody in particular, which
// makes it the wrong home for THIS text: the sentences below are load-bearing privacy promises,
// not labels. „Dein Text, die Liste unten und das Bild verlassen deinen Mac" is a claim that has
// to stay true, and the way it stays true is by living beside the code that makes it true, so
// that a person changing the payload sees the sentence in the same diff.
//
// GERMAN IS THE SOURCE. The English is a translation of it, not the other way round, because the
// tester is the PO's mother and the German is the copy she will actually read. Where the two
// differ in register they are allowed to: „Rückmeldung senden" is warmer than "Send feedback",
// and it should be.
//
// TONE, decided once so the screen does not drift into either of the two failure modes:
//   · not a bug tracker — no "steps to reproduce", no "severity", no "component"
//   · not a survey — no rating, no "how likely are you to recommend", no smiley faces.
//     Principle 9: the product does not study its user, and „bitte bewerten" is studying.

const DE = Object.freeze({
  // ── the entry point, in Einstellungen ──────────────────────────────────────────────────────
  sectionTitle: 'Hilfe',
  openButton: 'Rückmeldung senden …',
  sectionHint: 'Etwas funktioniert nicht, sieht falsch aus oder ist verwirrend? '
    + 'Schreib es auf — du siehst vorher genau, was verschickt wird.',

  // ── the sheet ──────────────────────────────────────────────────────────────────────────────
  sheetTitle: 'Rückmeldung senden',
  whatHappened: 'Was ist passiert?',
  placeholder: 'Zum Beispiel: „Der Balken für den Urlaub im Juli springt beim Ziehen eine Woche zurück."',
  required: 'Bitte schreib kurz auf, was passiert ist — ohne Text wird nichts verschickt.',

  previewTitle: 'Das wird verschickt — und sonst nichts',
  previewLead: 'Lies es in Ruhe durch. Genau dieser Text und genau dieses Bild verlassen deinen Mac, '
    + 'wenn du auf „Senden" drückst. Sonst nichts.',
  imageTitle: 'Dein Plan, ohne einen einzigen Buchstaben',
  imageLead: 'Das Bild wird neu gezeichnet, nicht abfotografiert: Wo Text stand, ist ein Kasten in '
    + 'derselben Größe. Die Wörter waren nie im Bild und lassen sich auch von uns nicht '
    + 'zurückholen.',
  imageNone: 'Kein Bild — der Plan war beim Öffnen dieses Fensters nicht sichtbar.',
  neverTitle: 'Was nie mitgeht',
  never: [
    'die Texte deiner Einträge und Notizen',
    'die Namen deiner Familienmitglieder',
    'deine Schlüssel und dein Wiederherstellungs-Backup',
    'die Kennung deines Familienkreises',
  ],

  send: 'Senden',
  sending: 'Wird gesendet …',
  cancel: 'Abbrechen',
  back: 'Zurück',
  next: 'Weiter zur Vorschau',
  copy: 'In die Zwischenablage kopieren',
  copied: 'Kopiert.',
  save: 'Als Datei sichern …',
  saved: 'Gesichert.',

  sentTitle: 'Danke — angekommen.',
  sentBody: 'Die Rückmeldung ist raus. Es gibt keine Antwortfunktion in der App; '
    + 'wenn Rückfragen nötig sind, meldet sich jemand auf dem üblichen Weg.',

  failedTitle: 'Das Senden hat nicht geklappt.',
  failedBody: 'Dass die Verbindung nicht steht, ist selbst eine nützliche Rückmeldung. '
    + 'Kopier den Text oder sichere ihn als Datei — dann geht er auch von Hand.',
  // ██ REWORDED, LZP-1009 SECOND PASS — THE OLD SENTENCE NAMED THE WRONG CONDITION. ██
  // It read „Solange du keinen Familienkreis nutzt, gibt es keinen Server, an den etwas gehen
  // könnte." That was true of the code and false of the world: the relay is one address, pinned
  // into the build, and it has nothing to do with whether this Mac is in a Familienkreis. The PO
  // amended story 21.5 on 2026-09-04/05 so that a solo Mac may send — because the report that
  // matters most is „ich kann nicht mitmachen", and only a solo Mac can write it. So the
  // remaining reason for a dead „Senden" is the honest one and the only one left: this BUILD has
  // no address in it. See `feedback/relay.js`.
  noRelay: 'Dieser Mac kennt keine Gegenstelle: In dieser Version ist keine Adresse hinterlegt, '
    + 'an die etwas gehen könnte. Kopier den Text oder sichere ihn als Datei.',
  tooLarge: 'Der Bericht ist zu groß (%1 kB, erlaubt sind %2 kB). Er wird nicht gekürzt — '
    + 'in der Vorschau stand, was verschickt wird, und ein gekürzter Bericht wäre gelogen. '
    + 'Schreib den Text etwas kürzer oder lass das Bild weg.',
  rateLimited: 'Es sind schon einige Berichte von hier gekommen. Bitte versuch es später '
    + 'noch einmal — oder sichere diesen als Datei.',

  withImage: 'Bild mitschicken',

  // ── the report itself. THESE STRINGS GO ON THE WIRE. ───────────────────────────────────────
  rHead: 'LangzeitPlaner — Rückmeldung',
  rVersion: 'Programm',
  rSystem: 'System',
  rScreen: 'Bildschirm',
  rWhen: 'Zeitpunkt',
  rText: 'Was ist passiert',
  rEvents: 'Verlauf (nur Struktur, keine Inhalte)',
  rEventsNone: '— nichts aufgezeichnet —',
  rEventsMore: '… und %1 weitere davor',
  rImage: 'Bild',
  rImageLine: 'Der Plan ohne Text: %1 × %2 Pixel, %3 kB, %4 Kästen für nicht gezeichneten Text.',
  rImageNone: '— kein Bild —',
  rUnknown: 'unbekannt',

  // ── „Berichte" — the OTHER end of the pipe, on one Mac (feedback/admin.js) ─────────────────
  //
  // The register changes here and it is allowed to. Everything above is written for the PO's
  // mother, who is using a calendar; this is written for the person who operates the relay and
  // who edited a flag into `board.json` by hand to see it at all. It may name
  // `LZP_REPORTS_ADMIN_PUB`, because he is the one who sets it.
  //
  // WHAT IS NOT HERE, AND MUST NEVER BE: a label for a reply box, a „antworten", a „Nachricht an
  // …". Principle 10 is a claim about the words on this screen as much as about its DOM, and a
  // copy key is how a feature gets built by accident — somebody adds the string, somebody else
  // finds it unused and wires it up.
  aSectionTitle: 'Berichte',
  aSectionHint: 'Rückmeldungen, die auf der Vermittlungsstelle liegen. Diese Ansicht gibt es nur '
    + 'auf diesem Mac und sie wird von Hand freigeschaltet — es gibt keinen Schalter dafür.',
  aMyKey: 'Öffentlicher Schlüssel dieses Macs',
  aMyKeyHint: 'Dieser Wert gehört als LZP_REPORTS_ADMIN_PUB auf die Vermittlungsstelle. Ohne ihn '
    + 'antwortet sie auf diese Ansicht mit „nicht gefunden" — sie soll nicht verraten, dass es '
    + 'sie gibt.',
  aNoKey: 'Auf diesem Mac liegt kein Geräteschlüssel. Er entsteht erst mit einem Familienkreis, '
    + 'und ohne ihn lassen sich die Berichte nicht abrufen.',
  aNoOrigin: 'Diese Version hat keine Gegenstelle hinterlegt — es gibt nichts abzurufen.',
  aCopyKey: 'Kopieren',
  aCopied: 'Kopiert.',
  aCopyFailed: 'Kopieren hat nicht geklappt.',
  aLoading: 'Wird geladen …',
  aNone: 'Keine Berichte.',
  aFailed: 'Die Berichte ließen sich nicht abrufen.',
  aExpires: 'verfällt am %1',
  aRetention: 'Berichte werden nach %1 Tagen automatisch gelöscht.',
  aSigned: 'signiert · %1',
  aUnsigned: 'ohne Signatur',
  aImageLoad: 'Bild anzeigen',
  aImageNone: 'Kein Bild.',
  aDelete: 'Löschen',
  aDeleteTitle: 'Diesen Bericht löschen?',
  aDeleteBody: 'Der Bericht wird auf der Vermittlungsstelle gelöscht, sofort und endgültig. '
    + 'Rückgängig machen lässt sich das nicht.',
  aDeleted: 'Gelöscht.',
  aNoReply: 'Hier gibt es keine Antwortmöglichkeit, und es wird auch keine geben: Der Kalender '
    + 'ist kein Nachrichtendienst. Wer antworten möchte, ruft an.',
});

const EN = Object.freeze({
  sectionTitle: 'Help',
  openButton: 'Send feedback …',
  sectionHint: 'Something broken, wrong, or confusing? Write it down — you will see exactly what '
    + 'gets sent before it goes.',

  sheetTitle: 'Send feedback',
  whatHappened: 'What happened?',
  placeholder: 'For example: "The bar for the July holiday jumps back a week when I drag it."',
  required: 'Please write down what happened — nothing is sent without it.',

  previewTitle: 'This is what gets sent — and nothing else',
  previewLead: 'Read it through. Exactly this text and exactly this image leave your Mac when you '
    + 'press "Send". Nothing else.',
  imageTitle: 'Your plan, without a single letter',
  imageLead: 'The image is re-drawn, not photographed: where text stood there is a box of the same '
    + 'size. The words were never in the image and cannot be recovered — not even by us.',
  imageNone: 'No image — the plan was not on screen when this window opened.',
  neverTitle: 'What never goes',
  never: [
    'the text of your entries and notes',
    'the names of your family members',
    'your keys and your recovery backup',
    'the identifier of your family circle',
  ],

  send: 'Send',
  sending: 'Sending …',
  cancel: 'Cancel',
  back: 'Back',
  next: 'Continue to preview',
  copy: 'Copy to clipboard',
  copied: 'Copied.',
  save: 'Save as file …',
  saved: 'Saved.',

  sentTitle: 'Thank you — it arrived.',
  sentBody: 'The report has gone. There is no reply function in the app; if anything needs asking, '
    + 'someone will get in touch the usual way.',

  failedTitle: 'Sending did not work.',
  failedBody: 'That the connection is down is itself useful feedback. Copy the text or save it as '
    + 'a file — it travels by hand just as well.',
  noRelay: 'This Mac knows no relay: this build has no address configured for anything to go to. '
    + 'Copy the text or save it as a file.',
  tooLarge: 'The report is too large (%1 kB; %2 kB allowed). It is not truncated — the preview '
    + 'said what would be sent, and a truncated report would be a lie. Write a little less, or '
    + 'leave the image out.',
  rateLimited: 'Several reports have already come from here. Please try again later — or save '
    + 'this one as a file.',

  withImage: 'Include the image',

  rHead: 'LangzeitPlaner — feedback',
  rVersion: 'Program',
  rSystem: 'System',
  rScreen: 'Screen',
  rWhen: 'Time',
  rText: 'What happened',
  rEvents: 'Trail (structure only, no content)',
  rEventsNone: '— nothing recorded —',
  rEventsMore: '… and %1 more before that',
  rImage: 'Image',
  rImageLine: 'The plan without text: %1 × %2 pixels, %3 kB, %4 boxes where text was not drawn.',
  rImageNone: '— no image —',
  rUnknown: 'unknown',

  aSectionTitle: 'Reports',
  aSectionHint: 'Feedback held on the relay. This view exists on this Mac only and is switched '
    + 'on by hand — there is no control for it.',
  aMyKey: "This Mac's public key",
  aMyKeyHint: 'This value belongs on the relay as LZP_REPORTS_ADMIN_PUB. Without it the relay '
    + 'answers this view with "not found" — it should not advertise that the view exists.',
  aNoKey: 'This Mac holds no device key. One is minted only with a family circle, and without it '
    + 'the reports cannot be read.',
  aNoOrigin: 'This build has no relay configured — there is nothing to read.',
  aCopyKey: 'Copy',
  aCopied: 'Copied.',
  aCopyFailed: 'Copying did not work.',
  aLoading: 'Loading …',
  aNone: 'No reports.',
  aFailed: 'The reports could not be read.',
  aExpires: 'expires on %1',
  aRetention: 'Reports are deleted automatically after %1 days.',
  aSigned: 'signed · %1',
  aUnsigned: 'unsigned',
  aImageLoad: 'Show image',
  aImageNone: 'No image.',
  aDelete: 'Delete',
  aDeleteTitle: 'Delete this report?',
  aDeleteBody: 'The report is deleted on the relay, at once and for good. This cannot be undone.',
  aDeleted: 'Deleted.',
  aNoReply: 'There is no reply here, and there will not be one: the calendar is not a messenger. '
    + 'Anyone who wants to answer picks up the telephone.',
});

const TABLES = { de: DE, en: EN };

/**
 * @param {'de'|'en'} lang
 * @param {string} key
 * @param {...(string|number)} args substituted for `%1`, `%2`, …
 * @returns {string|string[]}
 */
export function c(lang, key, ...args) {
  const table = TABLES[lang] || DE;
  const v = table[key] !== undefined ? table[key] : DE[key];
  if (typeof v !== 'string') return v;
  return v.replace(/%(\d)/g, (m, i) => {
    const a = args[Number(i) - 1];
    return a === undefined ? m : String(a);
  });
}

/** Exported so `tests/tier1/feedback.test.js` can assert both tables carry the same keys. */
export const COPY_TABLES = Object.freeze({ de: DE, en: EN });
