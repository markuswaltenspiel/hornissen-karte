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
const ENT_NAME = { feld: "ja (Meldefeld „beseitigt“)", text: "ja (laut Freitext)", nein: "nein (Meldefeld)", "?": "keine Angabe" };
const IND_ORDER = ["1 Ind.", "2-5 Ind.", "6-10 Ind.", "11-20 Ind.", "21-50 Ind.", "51-100 Ind.", "> 100 Ind.", "> 1000 Ind.", "> 10000 Ind."];

let farben = {};
function leseFarben() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["primaer", "sekundaer", "koenigin", "unklar", "einzel", "surface", "text-2"]) farben[k] = cs.getPropertyValue("--" + k).trim();
  farben.P = farben.primaer; farben.S = farben.sekundaer; farben.K = farben.koenigin; farben.U = farben.unklar;
}

// ---------- Daten ----------
let NESTER = [], EINZEL = [], META = {}, HEUTE = 0;

function saisonZu(t, kat) {
  const d = ausIdx(t), y = d.getUTCFullYear();
  if (kat === "P" || kat === "K") return y;
  return d.getUTCMonth() + 1 >= (META.saison_start_monat || 4) ? y : y - 1;
}

const zustand = {
  saisons: new Set(), vorjahr: true, typen: new Set(["P", "S", "U", "K"]), nurGesichert: false,
  ent: new Set(["aktiv", "entfernt"]), unfrei: false, einzel: false, radius: 2000,
  T: 0, zeitAktiv: false,
};

const freiOk = (x) => x.frei === "ja" || zustand.unfrei;
const anzeigeKat = (n) => (zustand.nurGesichert && n.stufe === "d") ? "U" : n.kat2;

// ---------- Karte ----------
let karte, renderer, popupOffen = null;
const KACHELN = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Daten: <a href="https://neobiota.naturschutzinformationen.nrw.de">LANUK NRW</a>';

function neueKarte(id) {
  const m = L.map(id, { preferCanvas: true, minZoom: 6 }).setView([51.45, 7.55], 8);
  L.tileLayer(KACHELN, { attribution: ATTR, maxZoom: 19 }).addTo(m);
  return m;
}

function stilNest(n, kat, entfernt, neu, blass) {
  const c = farben[kat];
  const r = (kat === "K" ? 4 : 5.5) + (neu ? 3 : 0);
  if (entfernt) return { radius: r, color: c, weight: 2.5, opacity: 1, fillColor: c, fillOpacity: 0 };
  return { radius: r, color: farben.surface, weight: 1, opacity: 1, fillColor: c, fillOpacity: blass ? 0.45 : 0.92 };
}

function popupNest(n) {
  const regel = n.regel ? REGEL[n.regel] : null;
  const ent = n.ent === "feld" || n.ent === "text";
  const entDatum = n.entd ? `${fmtIso(n.entd)} (${n.entq === "text" ? "aus Freitext" : "erstmals so gesehen"})` : (ent ? "unbekannt" : "–");
  return `<b>${KAT_NAME[n.kat2]}</b>${regel ? `<br><span style="color:#52514e">${esc(regel[0])} · ${STUFE[n.stufe]}</span>` : ""}
  <table>
  <tr><td>Fund</td><td>${fmtIso(n.d)}</td></tr>
  <tr><td>Gemeldet</td><td>${fmtIso(n.m)}</td></tr>
  <tr><td>Saison</td><td>${n.saison}</td></tr>
  <tr><td>Tiere (Schätzung)</td><td>${esc(n.ind || "keine Angabe")}</td></tr>
  <tr><td>Entfernt</td><td>${ENT_NAME[n.ent]}</td></tr>
  ${ent ? `<tr><td>Entfernt am</td><td>${entDatum}</td></tr>` : ""}
  <tr><td>Freigabe</td><td>${{ ja: "freigegeben", offen: "noch nicht bewertet", nein: "nicht freigegeben" }[n.frei]}</td></tr>
  <tr><td>Ort</td><td>${esc(n.gem || "")}${n.kreis && n.kreis !== n.gem ? ", " + esc(n.kreis) : ""}</td></tr>
  <tr><td>ID</td><td>${n.id}</td></tr></table>`;
}

function popupEinzel(e) {
  return `<b>Einzeltier</b><table>
  <tr><td>Fund</td><td>${fmtIso(e.d)}</td></tr>
  <tr><td>Nächstes Nest</td><td>${e.dn == null ? "über 10 km" : (e.dn / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " km"}</td></tr>
  <tr><td>Freigabe</td><td>${{ ja: "freigegeben", offen: "noch nicht bewertet", nein: "nicht freigegeben" }[e.frei]}</td></tr>
  <tr><td>ID</td><td>${e.id}</td></tr></table>`;
}

function zeichneKarte() {
  const T = zustand.zeitAktiv ? zustand.T : HEUTE;
  const zaehl = { P: 0, S: 0, U: 0, K: 0, aktiv: 0, entfernt: 0, E: 0 };
  for (const n of NESTER) {
    let sichtbar = freiOk(n) && zustand.saisons.has(n.saison) && n.t <= T;
    const kat = anzeigeKat(n);
    const entfernt = n.te != null && n.te <= T;
    if (sichtbar && zustand.vorjahr && n.saison < saisonZu(T, n.kat2)) sichtbar = false;
    if (sichtbar) { zaehl[kat]++; zaehl[entfernt ? "entfernt" : "aktiv"]++; }
    if (sichtbar && (!zustand.typen.has(kat) || !zustand.ent.has(entfernt ? "entfernt" : "aktiv"))) sichtbar = false;
    if (sichtbar) {
      const neu = zustand.zeitAktiv && T - n.t < 7;
      const schluessel = kat + entfernt + neu + (n.stufe === "d" && !zustand.nurGesichert);
      if (!n.marker) {
        n.marker = L.circleMarker([n.lat, n.lon], { renderer }).bindPopup(() => popupNest(n));
      }
      if (n.schluessel !== schluessel) { n.marker.setStyle(stilNest(n, kat, entfernt, neu, n.stufe === "d" && !zustand.nurGesichert)); n.marker.setRadius(stilNest(n, kat, entfernt, neu).radius); n.schluessel = schluessel; }
      if (!n.an) { n.marker.addTo(karte); n.an = true; }
    } else if (n.an) { n.marker.remove(); n.an = false; }
  }
  for (const e of EINZEL) {
    let sichtbar = zustand.einzel && freiOk(e) && zustand.saisons.has(e.saison) && e.t <= T
      && (e.dn == null || e.dn > zustand.radius);
    if (sichtbar && zustand.vorjahr && e.saison < ausIdx(T).getUTCFullYear()) sichtbar = false;
    if (sichtbar) {
      zaehl.E++;
      if (!e.marker) e.marker = L.circleMarker([e.lat, e.lon], { renderer, radius: 3, stroke: false, fillColor: farben.einzel, fillOpacity: 0.85 }).bindPopup(() => popupEinzel(e));
      if (!e.an) { e.marker.addTo(karte); e.an = true; }
    } else if (e.an) { e.marker.remove(); e.an = false; }
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
function stop() { clearInterval(timer); timer = null; $("#play").textContent = "▶"; }
function play() {
  if (timer) return stop();
  const z = $("#zeit");
  if (+z.value >= HEUTE) { zustand.zeitAktiv = true; zustand.T = +z.min; }
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
      L.circleMarker([n.lat, n.lon], { renderer: map._r, ...stilNest(n, kat, n.te != null, false, n.stufe === "d" && !zustand.nurGesichert) }).bindPopup(() => popupNest(n)).addTo(g);
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
    z[i]++; if (n.te != null) z[i + 1]++;
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
    ["Nester als entfernt gemeldet", proSaison((n) => nest(n) && n.te != null), "fett"],
    ["über Meldefeld „beseitigt“", proSaison((n) => nest(n) && n.ent === "feld"), "sub"],
    ["nur laut Freitext", proSaison((n) => nest(n) && n.ent === "text"), "sub"],
    ["Meldefeld „nein“", proSaison((n) => nest(n) && n.ent === "nein"), "sub"],
    ["keine Angabe", proSaison((n) => nest(n) && n.ent === "?"), "sub"],
    ["Einzeltiere", saisons.map((s) => E.filter((e) => e.saison === s).length), "fett"],
    [`davon ohne Nest im Umkreis von ${zustand.radius / 1000} km`, saisons.map((s) => E.filter((e) => e.saison === s && (e.dn == null || e.dn > zustand.radius)).length), "sub"],
  ];
  const nestSumme = proSaison(nest);
  const tab1 = `<table><thead><tr><th>Saison</th>${saisons.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody>${reihen.map(([t, w, art], i) => {
    const anteil = i >= 1 && i <= 5 || i >= 7 && i <= 11;
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
    <p class="erkl">Eine Saison umfasst Primärnester und Königinnen eines Kalenderjahres sowie die übrigen Nester bis Ende März des Folgejahres. „Gesichert“ heißt: eingeordnet über Freitext oder Tierzahl (Regeln 1–4). „Nach Meldedatum“: nur über den Fundmonat. Prozentwerte beziehen sich auf die Nesteinträge der Saison.</p>
    <div class="tabwrap">${tab1}</div>
    <h3>Nester je Fundmonat</h3>
    <div class="legende"><span><span class="dot" style="background:var(--primaer)"></span>Primärnest</span><span><span class="dot" style="background:var(--sekundaer)"></span>Sekundärnest</span><span><span class="dot" style="background:var(--unklar)"></span>unklar</span><span style="color:var(--muted)">blass = nach Meldedatum eingeordnet</span></div>
    <div class="multiples" id="multiples"></div>
    <h3>Wie die Nester eingeordnet wurden</h3>
    <p class="erkl">Die Regeln greifen in dieser Reihenfolge; die erste passende gilt.</p>
    <div class="tabwrap">${tab2}</div>
    <h3>Prüfung der Datumsregel</h3>
    <p class="erkl">Nur gesichert eingeordnete Nester. Die letzte Spalte zeigt, welcher Anteil der gesicherten Nester ab diesem Monat noch Primärnester sind – also wie groß der Fehler wäre, wenn man ab dort alles als Sekundärnest zählt.</p>
    <div class="tabwrap">${tab3}</div>
    <p class="erkl" style="margin-top:14px">Diese Tabelle ist allerdings zirkulär: Ab Juli gelten als „gesichert“ vor allem große Nester (> 100 Tiere), und die sind fast immer Sekundärnester. Für die Datumsregel zählen die kleinen Nester. Die folgende Tabelle zeigt deshalb nur Nester mit ≤ 100 Tieren oder ohne Schätzung, deren Typ im Freitext steht. Achtung, kleine Stichprobe: Wer „Primärnest“ dazuschreibt, tut das vielleicht gerade bei späten Funden.</p>
    <div class="tabwrap">${tab4}</div>`;
  zeichneMultiples(saisons, nn);
}

function zeichneMultiples(saisons, nn) {
  // Monate einer Saison: Jan des Saisonjahres bis März des Folgejahres (15 Balken)
  const LBL = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D", "J", "F", "M"];
  const serien = [["P", "g"], ["P", "d"], ["S", "g"], ["S", "d"], ["U", "u"]];
  const daten = {};
  let max = 0;
  for (const s of saisons) {
    const z = Array.from({ length: 15 }, () => serien.map(() => 0));
    for (const n of nn) {
      if (n.saison !== s) continue;
      const i = (+n.d.slice(0, 4) - s) * 12 + +n.d.slice(5, 7) - 1;
      if (i < 0 || i > 14) continue;
      const k = serien.findIndex(([t, st]) => t === n.kat2 && st === n.stufe);
      if (k >= 0) z[i][k]++;
    }
    z.forEach((m) => max = Math.max(max, m.reduce((a, b) => a + b, 0)));
    daten[s] = z;
  }
  const W = 320, H = 150, L0 = 34, B = 20, T0 = 6, bw = (W - L0 - 4) / 15;
  const y = (v) => H - B - (v / max) * (H - B - T0);
  const ticks = [0, Math.round(max / 2 / 100) * 100 || Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const html = saisons.map((s) => {
    let bars = "";
    daten[s].forEach((m, i) => {
      let acc = 0;
      const x = L0 + i * bw + 1.5, w = bw - 3;
      m.forEach((v, k) => {
        if (!v) return;
        const [t, st] = serien[k];
        const y1 = y(acc + v), y0 = y(acc);
        const h = Math.max(y0 - y1 - 2, 1);
        bars += `<rect x="${x}" y="${y1}" width="${w}" height="${h}" rx="${acc === 0 ? 0 : 0}" fill="${farben[t]}" fill-opacity="${st === "d" ? 0.45 : 1}"/>`;
        acc += v;
      });
      bars += `<rect class="hit" x="${L0 + i * bw}" y="${T0}" width="${bw}" height="${H - B - T0}" fill="transparent" data-s="${s}" data-i="${i}"/>`;
    });
    const achse = ticks.map((v) => `<line class="grid" x1="${L0}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L0 - 4}" y="${y(v) + 4}" text-anchor="end">${zahl(v)}</text>`).join("");
    const xl = LBL.map((l, i) => `<text x="${L0 + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${l}</text>`).join("");
    const trenn = `<line class="grid" x1="${L0 + 12 * bw}" x2="${L0 + 12 * bw}" y1="${T0}" y2="${H - B}" stroke-dasharray="3 3"/>`;
    return `<figure><figcaption>Saison ${s}</figcaption><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Nester je Fundmonat, Saison ${s}">${achse}${trenn}${bars}${xl}</svg></figure>`;
  }).join("");
  $("#multiples").innerHTML = html;
  const tip = $("#tooltip");
  const MON = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  $$("#multiples .hit").forEach((r) => {
    r.addEventListener("mousemove", (ev) => {
      const s = +r.dataset.s, i = +r.dataset.i, m = daten[s][i];
      const sum = m.reduce((a, b) => a + b, 0);
      tip.innerHTML = `<b>${MON[i % 12]} ${s + Math.floor(i / 12)}</b> · ${zahl(sum)} Nester<br>Primär: ${zahl(m[0])} gesichert, ${zahl(m[1])} nach Datum<br>Sekundär: ${zahl(m[2])} gesichert, ${zahl(m[3])} nach Datum<br>unklar: ${zahl(m[4])}`;
      tip.style.display = "block";
      tip.style.left = Math.min(ev.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = ev.clientY + 12 + "px";
    });
    r.addEventListener("mouseleave", () => tip.style.display = "none");
  });
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
}

function neuZeichnen() {
  if (aktiveAnsicht === "karte") zeichneKarte();
  if (aktiveAnsicht === "vergleich") zeichneVergleich();
  if (aktiveAnsicht === "statistik") statistik();
}

async function start() {
  leseFarben();
  const [n, e, m] = await Promise.all(["nester", "einzeltiere", "meta"].map((f) => fetch(`data/${f}.json`, { cache: "no-cache" }).then((r) => r.json())));
  META = m;
  const MONL = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"], stich = m.sekundaer_ab_monat || 8;
  REGEL.ab_aug[0] = `ab ${MONL[stich - 1]}, Schätzung ≤ 100 oder fehlt → Sekundärnest`;
  REGEL.rest[0] = `Juli${stich > 8 ? "–" + MONL[stich - 2] : ""}, Schätzung ≤ 100 oder fehlt → unklar`;
  HEUTE = tagIdx(m.stand.slice(0, 10));
  NESTER = n; EINZEL = e;
  for (const x of NESTER) {
    x.t = tagIdx(x.d);
    x.kat2 = x.kat === "koenigin" ? "K" : x.typ;
    x.te = (x.ent === "feld" || x.ent === "text") ? (x.entd ? Math.max(tagIdx(x.entd), x.t) : x.t) : null;
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
  $("#f-radius").oninput = (ev) => { zustand.radius = +ev.target.value; $("#radius-wert").textContent = (zustand.radius / 1000).toLocaleString("de-DE") + " km"; zeichneKarte(); };
  $("#zeit").oninput = (ev) => { stop(); setzeZeit(+ev.target.value); };
  $("#play").onclick = play;
  $("#zeit-ende").onclick = () => { stop(); setzeZeit(HEUTE); };
  $("#vgl-a").onchange = $("#vgl-b").onchange = zeichneVergleich;
  $$("nav.tabs button").forEach((b) => b.onclick = () => zeige(b.dataset.view));

  zeitBereich();
  zeichneKarte();
}

start().catch((err) => { $("#stand").textContent = "Fehler beim Laden der Daten: " + err.message; console.error(err); });
