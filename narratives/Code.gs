/**
 * Narrative Builder — Google Apps Script (bound to your narratives Google Doc)
 * Setup: in your Google Doc, Extensions → Apps Script. Paste this into Code.gs,
 * add an HTML file named "Index" with the contents of Index.html, save, then reload the doc.
 * A "Narratives" menu appears. Your work is stored with the script and the doc is
 * rewritten (a few seconds after each change) so it always shows every narrative.
 */

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Narratives')
    .addItem('Open Narrative Builder', 'openBuilder')
    .addToUi();
  try { PropertiesService.getScriptProperties().setProperty('DOC_ID', DocumentApp.getActiveDocument().getId()); } catch (e) {}
}

/** Opens the builder in a large window over the doc. */
function openBuilder() {
  PropertiesService.getScriptProperties().setProperty('DOC_ID', DocumentApp.getActiveDocument().getId());
  var html = HtmlService.createHtmlOutputFromFile('Index').setWidth(1400).setHeight(900);
  DocumentApp.getUi().showModelessDialog(html, 'Narrative Builder');
}

/** Lets you also run it full-screen in its own tab (Deploy → New deployment → Web app). */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Narrative Builder')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getDoc_() {
  try { var d = DocumentApp.getActiveDocument(); if (d) return d; } catch (e) {}
  var id = PropertiesService.getScriptProperties().getProperty('DOC_ID');
  if (!id) throw new Error('Open the doc once and use Narratives → Open Narrative Builder first.');
  return DocumentApp.openById(id);
}

/** Returns everything saved so far as a JSON string. */
function loadState() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var order = JSON.parse(props.order || '[]');
  var students = [];
  order.forEach(function (id) { if (props['s_' + id]) students.push(JSON.parse(props['s_' + id])); });
  return JSON.stringify({ settings: JSON.parse(props.settings || '{}'), students: students });
}

/** Saves changed students and rewrites the Google Doc. */
function saveState(json) {
  var p = JSON.parse(json);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sp = PropertiesService.getScriptProperties();
    var batch = { settings: JSON.stringify(p.settings || {}), order: JSON.stringify(p.order || []) };
    (p.students || []).forEach(function (s) { batch['s_' + s.id] = JSON.stringify(s); });
    sp.setProperties(batch, false);
    (p.removed || []).forEach(function (id) { sp.deleteProperty('s_' + id); });
    writeDoc_(p.doc || []);
  } finally {
    lock.releaseLock();
  }
  return new Date().toISOString();
}

function writeDoc_(rows) {
  var doc = getDoc_();
  var body = doc.getBody();
  body.clear();
  var tz = Session.getScriptTimeZone();
  var first = body.getParagraphs()[0];
  first.setText('Student Narratives').setHeading(DocumentApp.ParagraphHeading.TITLE);
  var done = rows.filter(function (r) { return r.state === 'done'; }).length;
  body.appendParagraph(done + ' of ' + rows.length + ' finished · updated ' +
      Utilities.formatDate(new Date(), tz, 'MMM d, h:mm a') +
      ' · Edit in Narratives → Open Narrative Builder (changes made directly here are overwritten).')
    .setHeading(DocumentApp.ParagraphHeading.NORMAL)
    .editAsText().setItalic(true).setFontSize(9).setForegroundColor('#6b7378');

  rows.forEach(function (r) {
    var h = body.appendParagraph((r.name || '(no name)') + ' — Grade ' + r.grade);
    h.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    var text = r.text && r.text.trim() ? r.text : '(not started)';
    var para = body.appendParagraph(text).setHeading(DocumentApp.ParagraphHeading.NORMAL);
    var t = para.editAsText();
    t.setItalic(false).setFontSize(11).setForegroundColor('#1f2a2e');
    if (!r.text || !r.text.trim()) t.setItalic(true).setForegroundColor('#9aa0a3');
    var note = r.words + ' words' + (r.words > 200 ? ' — OVER 200' : '') + (r.state === 'prog' ? ' — has blanks' : '');
    var n = body.appendParagraph(note).setHeading(DocumentApp.ParagraphHeading.NORMAL).editAsText();
    n.setItalic(false).setFontSize(8).setForegroundColor(r.words > 200 ? '#b3261e' : '#9aa0a3');
  });
  doc.saveAndClose();
}
