"use strict";

const TAG = 864e5;
const tagIdx = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / TAG; };
const ausIdx = (i) => new Date(i * TAG);
const fmt = (i) => ausIdx(i).toLocaleDateString("de-DE", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const fmtIso = (iso) => iso ? fmt(tagIdx(iso)) : "–";
const zahl = (n) => n.toLocaleString("de-DE");
const pct = (a, b) => b ? Math.round(100 * a / b) + " %" : "–";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const KAT_NAME = { P: "Primärnest", S: "Sekundärnest", U: "unklar", K: "Königin (ohne Nestangabe)" };
const REGEL = {
  text: ["Freitext nennt Primär-/Embryonal- bzw. Sekundärnest", "g"],
  gt1000: ["Schätzung > 1.000 Tiere → Sekundärnest", "g"],
  fj_le100: ["April–Juni, Schätzung ≤ 100 Tiere → Primärnest", "g"],
  so_gt100: ["ab Juli, Schätzung > 100 Tiere → Sekundärnest", "g"],
  fj_datum: ["April–Juni ohne Schätzung → Primärnest", "d"],
  fj_koenigin: ["Januar–März mit Königin → Primärnest", "d"],
  ab_aug: ["ab Stichmonat, Schätzung ≤ 100 oder fehlt → Sekundärnest", "d"],
  winter: ["Januar–März ohne Königin → Sekundärnest der Vorsaison", "d"],
  rest: ["Juli bis Stichmonat, Schätzung ≤ 100 oder fehlt → unklar", "u"],
};
const STUFE = { g: "gesichert (Regeln 1–4)", d: "nach Meldedatum", u: "unklar" };
const ENT_NAME = { feld: "ja (Meldefeld „beseitigt“)", text: "ja (laut Freitext)",  nein: "nein (Meldefeld)", "?": "keine Angabe" };
const IND_ORDER = ["1 Ind.", "2-5 Ind.", "6-10 Ind.", "11-20 Ind.", "21-50 Ind.", "51-100 Ind.", "> 100 Ind.", "> 1000 Ind.", "> 10000 Ind."];

const ARCGIS = "https://www.arcgishostedserver.nrw.de/arcgis/rest/services/Hosted";
const LANUK_APP = "https://www.giscloud.nrw.de/arcgis/apps/experiencebuilder/experience/?id=7a04965288004e779cecfe3f5a805425&data_id=";
const QUELLE = {
  nest: { layer: "Sicht_Vespa_velutina", ds: "dataSource_5-19e64cf540b-layer-8" },
  einzel: { layer: "Sicht_Vespa_velutina_Einzeltiere", ds: "dataSource_5-19e64cf4e60-layer-7" },
};
const istEnt = (n) => n.ent === "feld" || n.ent === "text";

let farben = {};
function leseFarben() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["primaer", "sekundaer", "koenigin", "unklar", "einzel", "einzelchart", "entfernt", "offen", "gbif", "surface", "text-2"]) farben[k] = cs.getPropertyValue("--" + k).trim();
  farben.P = farben.primaer; farben.S = farben.sekundaer; farben.K = farben.koenigin; farben.U = farben.unklar;
}

// ---------- Daten ----------
let NESTER = [], EINZEL = [], GBIF = [], META = {}, HEUTE = 0;

function saisonZu(t, kat) {
  const d = ausIdx(t), y = d.getUTCFullYear();
  if (kat === "P" || kat === "K") return y;
  return d.getUTCMonth() + 1 >= (META.saison_start_monat || 4) ? y : y - 1;
}

const zustand = {
  saisons: new Set(), vorjahr: true, typen: new Set(["P", "S", "U", "K"]), nurGesichert: false,
  ent: new Set(["aktiv", "entfernt", "entfernt_unb"]), unfrei: false, einzel: false, gbif: false, alleEinzel: false, radius: 2000,
  T: 0, zeitAktiv: false,
};

const freiOk = (x) => x.frei === "ja" || zustand.unfrei;
const anzeigeKat = (n) => (zustand.nurGesichert && n.stufe === "d") ? "U" : n.kat2;

// ---------- Karte ----------
let karte, renderer, popupOffen = null;
const KACHELN = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Daten: <a href="https://neobiota.naturschutzinformationen.nrw.de">LANUK NRW</a>, <a href="https://www.gbif.org/species/1311477">GBIF.org</a>';

function neueKarte(id) {
  const m = L.map(id, { preferCanvas: true, minZoom: 6 }).setView([51.45, 7.55], 8);
  L.tileLayer(KACHELN, { attribution: ATTR, maxZoom: 19 }).addTo(m);
  return m;
}

// status: "aktiv" | "entfernt" (Datum bekannt) | "entfernt_unb" (Zeitpunkt unbekannt)
function stilNest(n, kat, status, neu, blass) {
  const c = farben[kat];
  const r = (kat === "K" ? 4 : 5.5) + (neu ? 3 : 0);
  if (status === "entfernt") return { radius: r, color: c, weight: 2.5, opacity: 1, dashArray: null, fillColor: c, fillOpacity: 0 };
  if (status === "entfernt_unb") return { radius: r, color: c, weight: 2, opacity: 1, dashArray: "2 3", fillColor: c, fillOpacity: 0 };
  // Nur über den Fundmonat eingeordnet: Kontur in der eigenen Farbe, etwas hellere Füllung
  if (blass) return { radius: r, color: c, weight: 1, opacity: 1, dashArray: null, fillColor: c, fillOpacity: 0.8 };
  return { radius: r, color: farben.surface, weight: 1, opacity: 1, dashArray: null, fillColor: c, fillOpacity: 0.95 };
}
function statusZu(n, T) {
  if (!istEnt(n)) return "aktiv";
  if (n.te == null) return "entfernt_unb";
  return n.te <= T ? "entfernt" : "aktiv";
}

function popupNest(n) {
  const regel = n.regel ? REGEL[n.regel] : null;
  const ent = istEnt(n);
  const QT = { text: "aus Freitext", meldung: "war bei der Meldung schon entfernt", beob: "spätestens; an diesem Tag erstmals als entfernt gesehen", folge: "Funddatum der späteren Meldung, die „entfernt“ sagt" };
  const entDatum = n.entd ? `${fmtIso(n.entd)} (${QT[n.entq] || ""})` : "unbekannt";
  return `<b>${KAT_NAME[n.kat2]}</b>${regel ? `<br><span style="color:#52514e">${esc(regel[0])} · ${STUFE[n.stufe]}</span>` : ""}
  <table>
  <tr><td>Fund</td><td>${fmtIso(n.d)}</td></tr>
  <tr><td>Gemeldet</td><td>${fmtIso(n.m)}</td></tr>
  <tr><td>Saison</td><td>${n.saison}</td></tr>
  <tr><td>Tiere (Schätzung)</td><td>${esc(n.ind || "keine Angabe")}</td></tr>
  <tr><td>Entfernt</td><td>${ENT_NAME[n.ent]}</td></tr>
  ${ent ? `<tr><td>Entfernt am</td><td>${entDatum}</td></tr>` : ""}
  ${n.ids && n.ids.length > 1 ? `<tr><td>Meldungen</td><td>${n.ids.length} am selben Ort (zusammengeführt)</td></tr>` : ""}
  <tr><td>Freigabe</td><td>${{ ja: "freigegeben", offen: "noch nicht bewertet", nein: "nicht freigegeben" }[n.frei]}</td></tr>
  <tr><td>Ort</td><td>${esc(n.gem || "")}${n.kreis && n.kreis !== n.gem ? ", " + esc(n.kreis) : ""}</td></tr>
  </table>${quelleLinks("nest", n.ids || [n.id])}`;
}

function quelleLinks(art, ids) {
  const key = art + ids.join(","), fertig = fotoCache.get(key);
  const link = (id) => `<a href="${LANUK_APP}${QUELLE[art].ds}:${id}" target="_blank" rel="noopener">${ids.length > 1 ? "Meldung " + id : "In der LANUK-Karte öffnen"} ↗</a>`;
  return `<div class="fotos" data-art="${art}" data-ids="${ids.join(",")}"${fertig != null ? ' data-geladen="1"' : ""}>${fertig ?? '<span style="color:#7a7974;font-size:12px">Fotos werden geladen …</span>'}</div>
  ${ids.length > 1 ? `In der LANUK-Karte öffnen:<br>${ids.map(link).join("<br>")}` : link(ids[0])}<br><span style="color:#7a7974;font-size:11px">mit Bemerkung und Fotos${ids.length > 1 ? "" : " · ID " + ids[0]}</span>`;
}

const fotoCache = new Map();
// Fotos beim Öffnen des Detailfelds direkt beim LANUK abfragen (nichts wird kopiert)
async function ladeFotos(popup) {
  const el = popup.getElement()?.querySelector(".fotos");
  if (!el || el.dataset.geladen) return;
  el.dataset.geladen = "1";
  const { layer } = QUELLE[el.dataset.art], ids = el.dataset.ids, key = el.dataset.art + ids;
  const setze = (html) => { fotoCache.set(key, html); popup.update(); };
  try {
    const r = await fetch(`${ARCGIS}/${layer}/FeatureServer/0/queryAttachments?objectIds=${ids}&f=json`).then((x) => x.json());
    const infos = (r.attachmentGroups || []).flatMap((g) => g.attachmentInfos.map((a) => ({ ...a, oid: g.parentObjectId })))
      .filter((a) => (a.content_type || a.contentType || "").startsWith("image/"));
    if (!infos.length) return setze(`<span style="color:#7a7974;font-size:12px">Keine Fotos</span>`);
    setze(infos.slice(0, 6).map((a) => {
      const url = `${ARCGIS}/${layer}/FeatureServer/0/${a.oid}/attachments/${a.attachmentid ?? a.id}`;
      return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Foto" loading="lazy"></a>`;
    }).join("") + (infos.length > 6 ? `<span style="font-size:12px">+${infos.length - 6}</span>` : ""));
  } catch { setze(`<span style="color:#7a7974;font-size:12px">Fotos nicht abrufbar</span>`); }
}

const fernVonNest = (x) => zustand.alleEinzel || x.dn == null || x.dn > zustand.radius;
const kmText = (dn) => dn == null ? "über 10 km" : (dn / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " km";

function popupGbif(g) {
  return `<b>Sichtung (${esc(g.q)})</b><table>
  <tr><td>Fund</td><td>${fmtIso(g.d)}</td></tr>
  <tr><td>Nächstes Nest</td><td>${kmText(g.dn)}</td></tr>
  <tr><td>Lizenz</td><td>${esc(g.lic)}</td></tr></table>
  ${g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">Originalbeobachtung öffnen ↗</a><br>` : ""}
  <a href="https://www.gbif.org/occurrence/${g.id}" target="_blank" rel="noopener">GBIF-Datensatz ↗</a><br><span style="color:#7a7974;font-size:11px">Beobachtung über GBIF.org, ${esc(g.q)}</span>`;
}

function popupEinzel(e) {
  return `<b>Einzeltier</b><table>
  <tr><td>Fund</td><td>${fmtIso(e.d)}</td></tr>
  <tr><td>Nächstes Nest</td><td>${kmText(e.dn)}</td></tr>
  <tr><td>Freigabe</td><td>${{ ja: "freigegeben", offen: "noch nicht bewertet", nein: "nicht freigegeben" }[e.frei]}</td></tr>
  </table>${quelleLinks("einzel", [e.id])}`;
}

function zeichneKarte() {
  const T = zustand.zeitAktiv ? zustand.T : HEUTE;
  const zaehl = { P: 0, S: 0, U: 0, K: 0, aktiv: 0, entfernt: 0, entfernt_unb: 0, E: 0, G: 0 };
  for (const n of NESTER) {
    let sichtbar = freiOk(n) && zustand.saisons.has(n.saison) && n.t <= T;
    const kat = anzeigeKat(n);
    const status = statusZu(n, T);
    if (sichtbar && zustand.vorjahr && n.saison < saisonZu(T, n.kat2)) sichtbar = false;
    if (sichtbar) { zaehl[kat]++; zaehl[status]++; }
    if (sichtbar && (!zustand.typen.has(kat) || !zustand.ent.has(status))) sichtbar = false;
    if (sichtbar) {
      const neu = zustand.zeitAktiv && T - n.t < 7;
      const blass = n.stufe === "d" && !zustand.nurGesichert;
      const schluessel = kat + status + neu + blass;
      if (!n.marker) {
        n.marker = L.circleMarker([n.lat, n.lon], { renderer }).bindPopup(() => popupNest(n), { maxWidth: 320 });
      }
      if (n.schluessel !== schluessel) { const st = stilNest(n, kat, status, neu, blass); n.marker.setStyle(st); n.marker.setRadius(st.radius); n.schluessel = schluessel; }
      if (!n.an) { n.marker.addTo(karte); n.an = true; }
    } else if (n.an) { n.marker.remove(); n.an = false; }
  }
  for (const e of EINZEL) {
    let sichtbar = zustand.einzel && freiOk(e) && zustand.saisons.has(e.saison) && e.t <= T
      && fernVonNest(e);
    if (sichtbar && zustand.vorjahr && e.saison < ausIdx(T).getUTCFullYear()) sichtbar = false;
    if (sichtbar) {
      zaehl.E++;
      if (!e.marker) e.marker = L.circleMarker([e.lat, e.lon], { renderer, radius: 3, stroke: false, fillColor: farben.einzel, fillOpacity: 0.85 }).bindPopup(() => popupEinzel(e), { maxWidth: 320 });
      if (!e.an) { e.marker.addTo(karte); e.an = true; }
    } else if (e.an) { e.marker.remove(); e.an = false; }
  }
  for (const g of GBIF) {
    let sichtbar = zustand.gbif && !g.lanuk && zustand.saisons.has(g.saison) && g.t <= T && fernVonNest(g);
    if (sichtbar && zustand.vorjahr && g.saison < ausIdx(T).getUTCFullYear()) sichtbar = false;
    if (sichtbar) {
      zaehl.G++;
      if (!g.marker) g.marker = L.circleMarker([g.lat, g.lon], { renderer, radius: 3.5, color: farben.surface, weight: 0.8, fillColor: farben.gbif, fillOpacity: 0.9 }).bindPopup(() => popupGbif(g), { maxWidth: 320 });
      if (!g.an) { g.marker.addTo(karte); g.an = true; }
    } else if (g.an) { g.marker.remove(); g.an = false; }
  }
  for (const el of $$("aside .n")) el.textContent = zahl(zaehl[el.dataset.n] || 0);
  $("#zeit-datum").textContent = fmt(T);
}

// ---------- Zeitleiste ----------
let timer = null;
function zeitBereich() {
  let min = HEUTE;
  for (const n of NESTER) if (zustand.saisons.has(n.saison) && n.t < min) min = n.t;
  const z = $("#zeit");
  z.min = min; z.max = HEUTE;
  if (!zustand.zeitAktiv) z.value = HEUTE;
}
function setzeZeit(T) {
  zustand.T = Math.min(T, HEUTE);
  zustand.zeitAktiv = zustand.T < HEUTE;
  $("#zeit").value = zustand.T;
  zeichneKarte();
}
function springe(wert) {
  stop();
  if (wert === "") return setzeZeit(HEUTE);
  setzeZeit(Math.max(+wert, +$("#zeit").min));
}
function stop() { clearInterval(timer); timer = null; $("#play").textContent = "▶"; }
function play() {
  if (timer) return stop();
  const z = $("#zeit");
  if (+z.value >= HEUTE) { zustand.zeitAktiv = true; zustand.T = $("#sprung").value === "" ? +z.min : Math.max(+$("#sprung").value, +z.min); }
  zustand.zeitAktiv = true;
  $("#play").textContent = "⏸";
  timer = setInterval(() => {
    const T = zustand.T + +$("#tempo").value;
    if (T >= HEUTE) { stop(); setzeZeit(HEUTE); return; }
    zustand.T = T; $("#zeit").value = T; zeichneKarte();
  }, 140);
}

// ---------- Vergleich ----------
let mapA, mapB, vglSort = { spalte: 3, ab: true };
function zeichneVergleich() {
  for (const [map, sel, nEl] of [[mapA, "#vgl-a", "#vgl-a-n"], [mapB, "#vgl-b", "#vgl-b-n"]]) {
    if (!map) continue;
    map._gruppe?.remove();
    const s = +$(sel).value, g = L.layerGroup();
    let anz = 0;
    for (const n of NESTER) {
      if (n.saison !== s || n.kat2 === "K" || !freiOk(n)) continue;
      const kat = anzeigeKat(n);
      L.circleMarker([n.lat, n.lon], { renderer: map._r, ...stilNest(n, kat, statusZu(n, HEUTE), false, n.stufe === "d" && !zustand.nurGesichert) }).bindPopup(() => popupNest(n), { maxWidth: 320 }).addTo(g);
      anz++;
    }
    g.addTo(map); map._gruppe = g;
    $(nEl).textContent = zahl(anz) + " Nester";
  }
  const a = +$("#vgl-a").value, b = +$("#vgl-b").value, kreise = new Map();
  for (const n of NESTER) {
    if (n.kat2 === "K" || !freiOk(n) || (n.saison !== a && n.saison !== b)) continue;
    const k = n.kreis || "unbekannt";
    if (!kreise.has(k)) kreise.set(k, [0, 0, 0, 0]);
    const z = kreise.get(k), i = n.saison === a ? 0 : 2;
    z[i]++; if (istEnt(n)) z[i + 1]++;
  }
  const zeilen = [...kreise].map(([k, z]) => [k, z[0], z[1], z[2], z[3], z[2] - z[0]]);
  const sp = vglSort.spalte;
  zeilen.sort((x, y) => (typeof x[sp] === "string" ? x[sp].localeCompare(y[sp]) : x[sp] - y[sp]) * (vglSort.ab ? -1 : 1));
  const summe = zeilen.reduce((s, z) => s.map((v, i) => i ? v + z[i] : v), ["NRW gesamt", 0, 0, 0, 0, 0]);
  const kopf = ["Kreis", `${a}: Nester`, `${a}: entfernt`, `${b}: Nester`, `${b}: entfernt`, "Veränderung"];
  const zelle = (z) => `<td>${esc(z[0])}</td><td>${zahl(z[1])}</td><td>${zahl(z[2])} <span style="color:var(--muted)">(${pct(z[2], z[1])})</span></td><td>${zahl(z[3])}</td><td>${zahl(z[4])} <span style="color:var(--muted)">(${pct(z[4], z[3])})</span></td><td>${z[5] > 0 ? "+" : ""}${zahl(z[5])}</td>`;
  $("#vgl-tabelle").innerHTML = `<thead><tr>${kopf.map((h, i) => `<th data-i="${i}" style="cursor:pointer">${h}${i === sp ? (vglSort.ab ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
    <tbody><tr style="font-weight:600">${zelle(summe)}</tr>${zeilen.map((z) => `<tr>${zelle(z)}</tr>`).join("")}</tbody>`;
  $$("#vgl-tabelle th").forEach((th) => th.onclick = () => { const i = +th.dataset.i; vglSort = { spalte: i, ab: vglSort.spalte === i ? !vglSort.ab : true }; zeichneVergleich(); });
}

function initVergleich() {
  if (mapA) { mapA.invalidateSize(); mapB.invalidateSize(); return zeichneVergleich(); }
  mapA = neueKarte("map-a"); mapB = neueKarte("map-b");
  mapA._r = L.canvas(); mapB._r = L.canvas();
  let sperre = false;
  const sync = (von, zu) => von.on("move", () => { if (sperre) return; sperre = true; zu.setView(von.getCenter(), von.getZoom(), { animate: false }); sperre = false; });
  sync(mapA, mapB); sync(mapB, mapA);
  for (const m of [mapA, mapB]) m.on("popupopen", (ev) => ladeFotos(ev.popup));
  const leg = (c, t, extra = "") => `<span><span class="dot ${extra}" style="${extra ? "border-color" : "background"}:var(--${c})${extra === "ring dash" ? ";border-style:dashed" : ""}"></span>${t}</span>`;
  $("#vgl-legende").innerHTML = leg("primaer", "Primärnest") + leg("sekundaer", "Sekundärnest") + leg("unklar", "unklar")
    + leg("text-2", "entfernt, Datum bekannt", "ring") + leg("text-2", "entfernt, Zeitpunkt unbekannt", "ring dash") + `<span style="color:var(--muted)">etwas etwas heller = nur nach Fundmonat eingeordnet</span>`;
  zeichneVergleich();
}

// ---------- Statistik ----------
function statistik() {
  const saisons = [...new Set(NESTER.map((n) => n.saison))].sort();
  const N = NESTER.filter(freiOk), E = EINZEL.filter(freiOk);
  const proSaison = (f) => saisons.map((s) => N.filter((n) => n.saison === s && f(n)).length);
  const nest = (n) => n.kat2 !== "K";
  const reihen = [
    ["Nesteinträge (ohne Königinnen)", proSaison(nest), "fett"],
    ["Primärnest, gesichert", proSaison((n) => n.kat2 === "P" && n.stufe === "g"), "sub"],
    ["Primärnest, nach Meldedatum", proSaison((n) => n.kat2 === "P" && n.stufe === "d"), "sub"],
    ["Sekundärnest, gesichert", proSaison((n) => n.kat2 === "S" && n.stufe === "g"), "sub"],
    ["Sekundärnest, nach Meldedatum", proSaison((n) => n.kat2 === "S" && n.stufe === "d"), "sub"],
    ["unklar", proSaison((n) => n.kat2 === "U"), "sub"],
    ["Königin ohne Nestangabe", proSaison((n) => n.kat2 === "K")],
    ["zusammengeführte Doppelmeldungen", proSaison((n) => nest(n) && n.ids && n.ids.length > 1).map((_, j) => N.filter((n) => nest(n) && n.saison === saisons[j]).reduce((a, n) => a + (n.ids ? n.ids.length - 1 : 0), 0)), "sub"],
    ["Nester als entfernt gemeldet", proSaison((n) => nest(n) && istEnt(n)), "fett"],
    ["über Meldefeld „beseitigt“", proSaison((n) => nest(n) && n.ent === "feld"), "sub"],
    ["nur laut Freitext", proSaison((n) => nest(n) && n.ent === "text"), "sub"],
    ["Meldefeld „nein“", proSaison((n) => nest(n) && n.ent === "nein"), "sub"],
    ["keine Angabe", proSaison((n) => nest(n) && n.ent === "?"), "sub"],
    ["Entfernungsdatum aus späterer Meldung am selben Ort", proSaison((n) => nest(n) && n.entq === "folge"), "sub"],
    ["Einzeltiere", saisons.map((s) => E.filter((e) => e.saison === s).length), "fett"],
    [`davon ohne Nest im Umkreis von ${zustand.radius / 1000} km`, saisons.map((s) => E.filter((e) => e.saison === s && (e.dn == null || e.dn > zustand.radius)).length), "sub"],
    ["Weitere Sichtungen (GBIF, ohne LANUK-Doppel)", saisons.map((s) => GBIF.filter((g) => g.saison === s && !g.lanuk).length), "fett"],
    [`davon ohne Nest im Umkreis von ${zustand.radius / 1000} km`, saisons.map((s) => GBIF.filter((g) => g.saison === s && !g.lanuk && (g.dn == null || g.dn > zustand.radius)).length), "sub"],
  ];
  const nestSumme = proSaison(nest);
  const tab1 = `<table><thead><tr><th>Saison</th>${saisons.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody>${reihen.map(([t, w, art], i) => {
    const anteil = i >= 1 && i <= 5 || i >= 8 && i <= 13;
    return `<tr class="${art === "sub" ? "sub" : ""}" style="${art === "fett" ? "font-weight:600" : ""}"><td>${t}</td>${w.map((v, j) => `<td>${zahl(v)}${anteil ? ` <span style="color:var(--muted)">${pct(v, nestSumme[j])}</span>` : ""}</td>`).join("")}</tr>`;
  }).join("")}</tbody></table>`;

  const nn = N.filter(nest);
  const proRegel = Object.keys(REGEL).map((r) => [r, nn.filter((n) => n.regel === r).length]);
  const tab2 = `<table><thead><tr><th>Regel</th><th>Stufe</th><th>Nester</th><th>Anteil</th></tr></thead><tbody>${proRegel.map(([r, v], i) => `<tr><td>${i + 1}. ${esc(REGEL[r][0])}</td><td>${STUFE[REGEL[r][1]]}</td><td>${zahl(v)}</td><td>${pct(v, nn.length)}</td></tr>`).join("")}</tbody></table>`;

  const g = nn.filter((n) => n.stufe === "g");
  const monat = (n) => +n.d.slice(5, 7);
  const MON = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  let abP = 0, abS = 0;
  const zeilen3 = [];
  for (let m = 12; m >= 1; m--) {
    const p = g.filter((n) => monat(n) === m && n.kat2 === "P").length, s = g.filter((n) => monat(n) === m && n.kat2 === "S").length;
    abP += p; abS += s;
    zeilen3.unshift(`<tr><td>${MON[m - 1]}</td><td>${zahl(p)}</td><td>${zahl(s)}</td><td>${pct(p, p + s)}</td><td>${zahl(abP)} von ${zahl(abP + abS)} (${pct(abP, abP + abS)})</td></tr>`);
  }
  const MONL = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const stich = META.sekundaer_ab_monat || 8;
  const klein = nn.filter((n) => n.regel === "text" && !["> 100 Ind.", "> 1000 Ind.", "> 10000 Ind."].includes(n.ind));
  const tab4 = `<table><thead><tr><th>Fundmonat</th><th>Primär (Freitext)</th><th>Sekundär (Freitext)</th><th>Anteil primär</th></tr></thead><tbody>${[7, 8, 9, 10, 11, 12].map((m) => {
    const p = klein.filter((n) => monat(n) === m && n.kat2 === "P").length, s = klein.filter((n) => monat(n) === m && n.kat2 === "S").length;
    return `<tr${m === stich ? ' style="font-weight:600"' : ""}><td>${MON[m - 1]}${m === stich ? " (Stichmonat)" : ""}</td><td>${zahl(p)}</td><td>${zahl(s)}</td><td>${pct(p, p + s)}</td></tr>`;
  }).join("")}</tbody></table>`;
  const tab3 = `<table><thead><tr><th>Fundmonat</th><th>Primär (gesichert)</th><th>Sekundär (gesichert)</th><th>Anteil primär</th><th>Primär ab diesem Monat</th></tr></thead><tbody>${zeilen3.join("")}</tbody></table>`;

  $("#statistik").innerHTML = `
    <h3>Übersicht nach Saison</h3>
    <p class="erkl">Doppelmeldungen sind herausgerechnet: Meldungen höchstens 20 m und 120 Tage nach der ersten Meldung eines Nests derselben Saison zählen als dasselbe Nest. Eine Saison umfasst Primärnester und Königinnen eines Kalenderjahres sowie die übrigen Nester bis Ende März des Folgejahres. „Gesichert“ heißt: eingeordnet über Freitext oder Tierzahl (Regeln 1–4). „Nach Meldedatum“: nur über den Fundmonat. Prozentwerte beziehen sich auf die Nesteinträge der Saison.</p>
    <div class="tabwrap">${tab1}</div>
    <h3>Alle Funde im Zeitverlauf</h3>
    <p class="erkl">Nach Funddatum, Kalendermonate. Oben Nester und Königinnen, unten Einzeltiere (eigene Skala).</p>
    <div class="legende"><span><span class="dot" style="background:var(--primaer)"></span>Primärnest</span><span><span class="dot" style="background:var(--sekundaer)"></span>Sekundärnest</span><span><span class="dot" style="background:var(--unklar)"></span>unklar</span><span><span class="dot" style="background:var(--koenigin)"></span>Königin (ohne Nestangabe)</span></div>
    <div class="breit" id="gesamt-nester"></div>
    <div class="legende"><span><span class="dot" style="background:var(--einzelchart)"></span>Einzeltiere</span></div>
    <div class="breit" id="gesamt-einzel"></div>
    <h3>Nester je Fundmonat</h3>
    <div class="legende"><span><span class="dot" style="background:var(--primaer)"></span>Primärnest</span><span><span class="dot" style="background:var(--sekundaer)"></span>Sekundärnest</span><span><span class="dot" style="background:var(--unklar)"></span>unklar</span><span style="color:var(--muted)">etwas heller = nur nach Fundmonat eingeordnet</span></div>
    <div class="multiples" id="multiples"></div>
    <h3>Entfernte Nester</h3>
    <p class="erkl">Für die meisten Entfernungen ist der Zeitpunkt unbekannt. Die Grafiken ordnen entfernte Nester deshalb nach ihrem <b>Fundmonat</b>: „Juli“ heißt also „im Juli gefunden und irgendwann als entfernt gemeldet“. Jüngere Monate holen noch auf, weil Entfernungen oft erst Wochen später eingetragen werden.</p>
    <div class="legende"><span><span class="dot" style="background:var(--primaer)"></span>Primärnest</span><span><span class="dot" style="background:var(--sekundaer)"></span>Sekundärnest</span><span><span class="dot" style="background:var(--unklar)"></span>unklar</span></div>
    <div class="multiples" id="entfernt-total"></div>
    <h3>Gemeldet und entfernt</h3>
    <div class="legende"><span><span class="dot" style="background:var(--entfernt)"></span>als entfernt gemeldet</span><span><span class="dot" style="background:var(--offen)"></span>nicht als entfernt gemeldet</span>
      <span style="margin-left:auto" class="umschalter"><label><input type="radio" name="entf-modus" value="abs"${entfProzent ? "" : " checked"}> absolut</label> <label><input type="radio" name="entf-modus" value="pct"${entfProzent ? " checked" : ""}> Anteil in %</label></span></div>
    <p class="erkl">Die ganze Säule ist die Zahl der in diesem Monat neu gemeldeten Nester, der violette Teil davon wurde als entfernt gemeldet. In der Prozentansicht fehlen Monate mit weniger als 5 Nestern; dort steht nur die Anzahl.</p>
    <div class="multiples" id="entfernt-anteil"></div>
    <h3>Wie die Nester eingeordnet wurden</h3>
    <p class="erkl">Die Regeln greifen in dieser Reihenfolge; die erste passende gilt.</p>
    <div class="tabwrap">${tab2}</div>
    <h3>Prüfung der Datumsregel</h3>
    <p class="erkl">Nur gesichert eingeordnete Nester. Die letzte Spalte zeigt, welcher Anteil der gesicherten Nester ab diesem Monat noch Primärnester sind – also wie groß der Fehler wäre, wenn man ab dort alles als Sekundärnest zählt.</p>
    <div class="tabwrap">${tab3}</div>
    <p class="erkl" style="margin-top:14px">Diese Tabelle ist allerdings zirkulär: Ab Juli gelten als „gesichert“ vor allem große Nester (> 100 Tiere), und die sind fast immer Sekundärnester. Für die Datumsregel zählen die kleinen Nester. Die folgende Tabelle zeigt deshalb nur Nester mit ≤ 100 Tieren oder ohne Schätzung, deren Typ im Freitext steht. Achtung, kleine Stichprobe: Wer „Primärnest“ dazuschreibt, tut das vielleicht gerade bei späten Funden.</p>
    <div class="tabwrap">${tab4}</div>`;
  zeichneMultiples(saisons, nn);
  zeichneGesamt(N, E);
  zeichneEntfernt(saisons, nn);
  zeichneEntferntAnteil(saisons, nn);
  $$('input[name="entf-modus"]').forEach((r) => r.onchange = () => { entfProzent = r.value === "pct"; zeichneEntferntAnteil(saisons, nn); });
}

const MON_LANG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MON_KURZ = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function schoeneSchritte(max) {
  if (max <= 0) return [0];
  const roh = max / 3, p = 10 ** Math.floor(Math.log10(roh)), f = roh / p;
  const schritt = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p, out = [];
  for (let v = 0; v <= max; v += schritt) out.push(v);
  return out;
}

// Gestapelte Säulen, mehrere Felder mit gemeinsamer y-Achse.
// panels: [{ titel, labels, werte: [[v je Serie] je Balken], trenn, tip(i) }]
// serien: [{ farbe, deckkraft }]; opt: { W, H, prozent, id }
function balken(ziel, panels, serien, opt = {}) {
  const W = opt.W || 320, H = opt.H || 150, L0 = 38, B = 20, T0 = 6;
  const summe = (m) => m.reduce((a, b) => a + b, 0);
  const max = opt.prozent ? 100 : Math.max(1, ...panels.flatMap((p) => p.werte.map(summe)));
  const ticks = opt.prozent ? [0, 50, 100] : schoeneSchritte(max);
  const top = opt.prozent ? 100 : Math.max(max, ticks.at(-1));
  const y = (v) => H - B - (v / top) * (H - B - T0);
  const html = panels.map((p, pi) => {
    const n = p.labels.length, bw = (W - L0 - 4) / n, luecke = Math.min(3, bw * 0.25);
    let bars = "";
    p.werte.forEach((m, i) => {
      const tot = summe(m);
      if (opt.prozent && tot < (opt.minN || 1)) {
        if (tot) bars += `<text x="${L0 + i * bw + bw / 2}" y="${H - B - 4}" text-anchor="middle" style="font-size:9px">${tot}</text>`;
        bars += `<rect class="hit" x="${L0 + i * bw}" y="${T0}" width="${bw}" height="${H - B - T0}" fill="transparent" data-p="${pi}" data-i="${i}"/>`;
        return;
      }
      let acc = 0;
      const x = L0 + i * bw + luecke / 2, w = bw - luecke;
      m.forEach((v, k) => {
        if (!v) return;
        const wert = opt.prozent ? (100 * v) / tot : v;
        const y1 = y(acc + wert), y0 = y(acc);
        const h = Math.max(y0 - y1 - (acc ? 1.5 : 0), 0.8);
        bars += `<rect x="${x}" y="${y1}" width="${w}" height="${h}" fill="${serien[k].farbe}" fill-opacity="${serien[k].deckkraft ?? 1}"/>`;
        acc += wert;
      });
      bars += `<rect class="hit" x="${L0 + i * bw}" y="${T0}" width="${bw}" height="${H - B - T0}" fill="transparent" data-p="${pi}" data-i="${i}"/>`;
    });
    const achse = ticks.map((v) => `<line class="grid" x1="${L0}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L0 - 4}" y="${y(v) + 4}" text-anchor="end">${zahl(v)}${opt.prozent ? " %" : ""}</text>`).join("");
    const xl = p.labels.map((l, i) => l ? `<text x="${L0 + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${l}</text>` : "").join("");
    const trenn = (p.trenn || []).map((t) => `<line class="grid" x1="${L0 + t * bw}" x2="${L0 + t * bw}" y1="${T0}" y2="${H - B}" stroke-dasharray="3 3"/>`).join("");
    const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(p.titel || "")}">${achse}${trenn}${bars}${xl}</svg>`;
    return p.titel ? `<figure><figcaption>${esc(p.titel)}</figcaption>${svg}</figure>` : `<figure>${svg}</figure>`;
  }).join("");
  const el = $(ziel);
  el.innerHTML = html;
  const tip = $("#tooltip");
  el.querySelectorAll(".hit").forEach((r) => {
    r.addEventListener("mousemove", (ev) => {
      tip.innerHTML = panels[+r.dataset.p].tip(+r.dataset.i);
      tip.style.display = "block";
      tip.style.left = Math.min(ev.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = ev.clientY + 12 + "px";
    });
    r.addEventListener("mouseleave", () => tip.style.display = "none");
  });
}

// Monatsindex einer Saison: Jan des Saisonjahres = 0 … März des Folgejahres = 14
const saisonMonat = (n) => (+n.d.slice(0, 4) - n.saison) * 12 + +n.d.slice(5, 7) - 1;
const SAISON_LBL = [...MON_KURZ, "J", "F", "M"];
const monatName = (s, i) => `${MON_LANG[i % 12]} ${s + Math.floor(i / 12)}`;

function zeichneMultiples(saisons, nn) {
  const serien = [["P", "g"], ["P", "d"], ["S", "g"], ["S", "d"], ["U", "u"]];
  const panels = saisons.map((s) => {
    const z = Array.from({ length: 15 }, () => serien.map(() => 0));
    for (const n of nn) {
      if (n.saison !== s) continue;
      const i = saisonMonat(n), k = serien.findIndex(([t, st]) => t === n.kat2 && st === n.stufe);
      if (i >= 0 && i <= 14 && k >= 0) z[i][k]++;
    }
    return { titel: `Saison ${s}`, labels: SAISON_LBL, werte: z, trenn: [12], tip: (i) => {
      const m = z[i];
      return `<b>${monatName(s, i)}</b> · ${zahl(m.reduce((a, b) => a + b, 0))} Nester<br>Primär: ${zahl(m[0])} gesichert, ${zahl(m[1])} nach Datum<br>Sekundär: ${zahl(m[2])} gesichert, ${zahl(m[3])} nach Datum<br>unklar: ${zahl(m[4])}`;
    } };
  });
  balken("#multiples", panels, serien.map(([t, st]) => ({ farbe: farben[t], deckkraft: st === "d" ? 0.8 : 1 })));
}

// Alle Funde im gesamten Zeitraum, Kalendermonate nach Funddatum
function zeichneGesamt(N, E) {
  // Beginn: Januar des ersten Jahres mit Nestmeldungen (vereinzelte frühere Einzeltiere fallen weg)
  const start = N.map((n) => n.d).sort()[0].slice(0, 4) + "-01", ende = ausIdx(HEUTE).toISOString().slice(0, 7);
  const monate = [];
  for (let [y, m] = start.split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= ende; m === 12 ? (y++, m = 1) : m++) monate.push(`${y}-${String(m).padStart(2, "0")}`);
  const idx = new Map(monate.map((m, i) => [m, i]));
  const serien = ["P", "S", "U", "K"];
  const z = monate.map(() => [0, 0, 0, 0]), ze = monate.map(() => [0]);
  for (const n of N) { const i = idx.get(n.d.slice(0, 7)); if (i != null) z[i][serien.indexOf(n.kat2)]++; }
  for (const e of E) { const i = idx.get(e.d.slice(0, 7)); if (i != null) ze[i][0]++; }
  const labels = monate.map((m) => m.endsWith("-01") ? m.slice(0, 4) : (monate.length < 30 ? MON_KURZ[+m.slice(5) - 1] : ""));
  const trenn = monate.map((m, i) => (m.endsWith("-01") && i ? i : null)).filter((i) => i != null);
  const name = (i) => `${MON_LANG[+monate[i].slice(5) - 1]} ${monate[i].slice(0, 4)}`;
  balken("#gesamt-nester", [{ labels, werte: z, trenn, tip: (i) => `<b>${name(i)}</b><br>Primärnester: ${zahl(z[i][0])}<br>Sekundärnester: ${zahl(z[i][1])}<br>unklar: ${zahl(z[i][2])}<br>Königinnen: ${zahl(z[i][3])}<br>Einzeltiere: ${zahl(ze[i][0])}` }],
    serien.map((t) => ({ farbe: farben[t] })), { W: 1000, H: 190 });
  balken("#gesamt-einzel", [{ labels, werte: ze, trenn, tip: (i) => `<b>${name(i)}</b><br>Einzeltiere: ${zahl(ze[i][0])}<br>Nester und Königinnen: ${zahl(z[i].reduce((a, b) => a + b, 0))}` }],
    [{ farbe: farben.einzelchart }], { W: 1000, H: 150 });
}

// Entfernte Nester je Fundmonat, nach Nesttyp
function zeichneEntfernt(saisons, nn) {
  const serien = ["P", "S", "U"];
  const panels = saisons.map((s) => {
    const z = Array.from({ length: 15 }, () => [0, 0, 0]);
    for (const n of nn) {
      if (n.saison !== s || !istEnt(n)) continue;
      const i = saisonMonat(n);
      if (i >= 0 && i <= 14) z[i][serien.indexOf(n.kat2)]++;
    }
    const tot = z.flat().reduce((a, b) => a + b, 0);
    return { titel: `Saison ${s} · ${zahl(tot)} entfernt`, labels: SAISON_LBL, werte: z, trenn: [12], tip: (i) =>
      `<b>gefunden ${monatName(s, i)}</b><br>davon entfernt: ${zahl(z[i][0] + z[i][1] + z[i][2])}<br>Primärnester: ${zahl(z[i][0])}<br>Sekundärnester: ${zahl(z[i][1])}<br>unklar: ${zahl(z[i][2])}` };
  });
  balken("#entfernt-total", panels, serien.map((t) => ({ farbe: farben[t] })));
}

// Gemeldet vs. entfernt je Fundmonat, absolut oder als Anteil
let entfProzent = false;
function zeichneEntferntAnteil(saisons, nn) {
  const panels = saisons.map((s) => {
    const z = Array.from({ length: 15 }, () => [0, 0]);
    for (const n of nn) {
      if (n.saison !== s) continue;
      const i = saisonMonat(n);
      if (i >= 0 && i <= 14) z[i][istEnt(n) ? 0 : 1]++;
    }
    const e = z.reduce((a, m) => a + m[0], 0), g = z.reduce((a, m) => a + m[0] + m[1], 0);
    return { titel: `Saison ${s} · ${pct(e, g)} entfernt`, labels: SAISON_LBL, werte: z, trenn: [12], tip: (i) =>
      `<b>gefunden ${monatName(s, i)}</b><br>neu gemeldet: ${zahl(z[i][0] + z[i][1])}<br>als entfernt gemeldet: ${zahl(z[i][0])} (${pct(z[i][0], z[i][0] + z[i][1])})<br>nicht als entfernt gemeldet: ${zahl(z[i][1])}` };
  });
  balken("#entfernt-anteil", panels, [{ farbe: farben.entfernt }, { farbe: farben.offen }], { prozent: entfProzent, minN: 5 });
}

// ---------- Start ----------
let aktiveAnsicht = "karte";
function zeige(ansicht) {
  aktiveAnsicht = ansicht;
  $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === ansicht));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + ansicht));
  if (ansicht === "karte") karte.invalidateSize();
  if (ansicht === "vergleich") initVergleich();
  if (ansicht === "statistik") statistik();
  if (ansicht === "deutschland") initDeutschland().catch((e) => { $("#de-datum").textContent = "Fehler: " + e.message; console.error(e); });
}

function neuZeichnen() {
  if (aktiveAnsicht === "karte") zeichneKarte();
  if (aktiveAnsicht === "vergleich") zeichneVergleich();
  if (aktiveAnsicht === "statistik") statistik();
}

async function start() {
  leseFarben();
  const [n, e, m, gb] = await Promise.all(["nester", "einzeltiere", "meta", "gbif"].map((f) => fetch(`data/${f}.json`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : []).catch(() => [])));
  GBIF = gb || [];
  for (const x of GBIF) x.t = tagIdx(x.d);
  META = m;
  const MONL = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"], stich = m.sekundaer_ab_monat || 8;
  REGEL.ab_aug[0] = `ab ${MONL[stich - 1]}, Schätzung ≤ 100 oder fehlt → Sekundärnest`;
  REGEL.rest[0] = `Juli${stich > 8 ? "–" + MONL[stich - 2] : ""}, Schätzung ≤ 100 oder fehlt → unklar`;
  HEUTE = tagIdx(m.stand.slice(0, 10));
  NESTER = n; EINZEL = e;
  for (const x of NESTER) {
    x.t = tagIdx(x.d);
    x.kat2 = x.kat === "koenigin" ? "K" : x.typ;
    x.te = istEnt(x) && x.entd ? Math.max(tagIdx(x.entd), x.t) : null;
  }
  for (const x of EINZEL) x.t = tagIdx(x.d);
  NESTER.sort((a, b) => a.t - b.t);
  $("#stand").textContent = "Datenstand " + new Date(m.stand).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });

  const saisons = [...new Set(NESTER.map((x) => x.saison))].sort();
  saisons.forEach((s) => zustand.saisons.add(s));
  $("#f-saisons").innerHTML = saisons.map((s) => `<label><input type="checkbox" class="f-saison" value="${s}" checked> ${s}</label>`).join("");
  for (const id of ["#vgl-a", "#vgl-b"]) $(id).innerHTML = saisons.map((s) => `<option>${s}</option>`).join("");
  $("#vgl-a").value = saisons.at(-2) ?? saisons[0]; $("#vgl-b").value = saisons.at(-1);

  karte = neueKarte("karte");
  renderer = L.canvas({ padding: 0.3 });

  $$(".f-saison").forEach((el) => el.onchange = () => { el.checked ? zustand.saisons.add(+el.value) : zustand.saisons.delete(+el.value); zeitBereich(); zeichneKarte(); });
  $$(".f-typ").forEach((el) => el.onchange = () => { el.checked ? zustand.typen.add(el.value) : zustand.typen.delete(el.value); zeichneKarte(); });
  $$(".f-ent").forEach((el) => el.onchange = () => { el.checked ? zustand.ent.add(el.value) : zustand.ent.delete(el.value); zeichneKarte(); });
  $("#f-vorjahr").onchange = (ev) => { zustand.vorjahr = ev.target.checked; zeichneKarte(); };
  $("#f-nurgesichert").onchange = (ev) => { zustand.nurGesichert = ev.target.checked; neuZeichnen(); };
  $("#f-unfrei").onchange = (ev) => { zustand.unfrei = ev.target.checked; neuZeichnen(); };
  $("#f-einzel").onchange = (ev) => { zustand.einzel = ev.target.checked; zeichneKarte(); };
  $("#f-gbif").onchange = (ev) => { zustand.gbif = ev.target.checked; zeichneKarte(); };
  $("#f-alle-einzel").onchange = (ev) => { zustand.alleEinzel = ev.target.checked; zeichneKarte(); };
  $("#f-radius").oninput = (ev) => { zustand.radius = +ev.target.value; $("#radius-wert").textContent = (zustand.radius / 1000).toLocaleString("de-DE") + " km"; zeichneKarte(); };
  $("#zeit").oninput = (ev) => { stop(); setzeZeit(+ev.target.value); };
  $("#play").onclick = play;
  $("#zeit-ende").onclick = () => { stop(); $("#sprung").value = ""; setzeZeit(HEUTE); };
  $("#sprung").onchange = (ev) => springe(ev.target.value);
  karte.on("popupopen", (ev) => ladeFotos(ev.popup));
  $("#vgl-a").onchange = $("#vgl-b").onchange = zeichneVergleich;
  $$("nav.tabs button").forEach((b) => b.onclick = () => zeige(b.dataset.view));

  const jahre = [...new Set(NESTER.map((x) => +x.d.slice(0, 4)))].sort();
  $("#sprung").innerHTML = `<option value="">Abspielen ab …</option>` + jahre.map((y) => `<option value="${Date.UTC(y, 0, 1) / TAG}">1.1.${y}</option><option value="${Date.UTC(y, 3, 1) / TAG}">1.4.${y}</option>`).join("");
  zeitBereich();
  zeichneKarte();
}

start().catch((err) => { $("#stand").textContent = "Fehler beim Laden der Daten: " + err.message; console.error(err); });
