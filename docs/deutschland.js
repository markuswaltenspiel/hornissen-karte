"use strict";
// Reiter „Deutschland“: Ausbreitung über die Zeit. Nutzt Hilfsfunktionen aus app.js.

const DE = { daten: null, karte: null, ebene: null, T: 0, min: 0, timer: null, modus: "kumuliert", typen: new Set(["N", "E"]), quellen: new Set(), punkte: [] };
const DE_STUFEN = [ // Fundjahr → Stufe (älter = heller, neuer = dunkler)
  { name: "bis 2022", bis: 2022 }, { name: "2023", bis: 2023 }, { name: "2024", bis: 2024 }, { name: "2025", bis: 2025 }, { name: "2026", bis: 9999 },
];
const DE_FARBEN_HELL = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const DE_FARBEN_DUNKEL = ["#1c5cab", "#256abf", "#3987e5", "#6da7ec", "#cde2fb"];
const deFarben = () => (matchMedia("(prefers-color-scheme: dark)").matches ? DE_FARBEN_DUNKEL : DE_FARBEN_HELL);
const stufeVon = (jahr) => DE_STUFEN.findIndex((s) => jahr <= s.bis);

const PunktEbene = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._c = L.DomUtil.create("canvas", "leaflet-zoom-hide");
    map.getPanes().overlayPane.appendChild(this._c);
    map.on("moveend zoomend resize", this._reset, this);
    this._reset();
  },
  onRemove(map) { L.DomUtil.remove(this._c); map.off("moveend zoomend resize", this._reset, this); },
  _reset() {
    const s = this._map.getSize(), dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(this._c, this._map.containerPointToLayerPoint([0, 0]));
    this._c.width = s.x * dpr; this._c.height = s.y * dpr;
    this._c.style.width = s.x + "px"; this._c.style.height = s.y + "px";
    this.zeichne();
  },
  zeichne() {
    if (!this._map) return;
    const ctx = this._c.getContext("2d"), dpr = window.devicePixelRatio || 1, map = this._map;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this._c.width, this._c.height);
    const farben = deFarben(), rand = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    const z = map.getZoom(), rE = z < 7 ? 1.6 : z < 9 ? 2.2 : 3, rN = rE + 1.6;
    for (const p of DE.punkte) { // schon nach Datum sortiert: Neuere liegen oben
      const c = map.latLngToContainerPoint([p[0], p[1]]);
      p.x = c.x; p.y = c.y;
      ctx.beginPath();
      ctx.arc(c.x, c.y, p[4] === "N" ? rN : rE, 0, 6.283);
      ctx.fillStyle = farben[p.stufe];
      ctx.fill();
      if (p[4] === "N") { ctx.lineWidth = 1; ctx.strokeStyle = rand; ctx.stroke(); }
    }
  },
});

function deFilter() {
  const T = DE.T, von = DE.modus === "jahr" ? T - 365 : -Infinity, z = { N: 0, E: 0 }, proStufe = DE_STUFEN.map(() => 0);
  DE.punkte = [];
  for (const p of DE.daten.zeilen) {
    if (p.t > T || p.t <= von || !DE.quellen.has(p[3])) continue;
    z[p[4]]++;
    if (!DE.typen.has(p[4])) continue;
    proStufe[p.stufe]++;
    DE.punkte.push(p);
  }
  $$("[data-de]").forEach((el) => el.textContent = zahl(z[el.dataset.de]));
  const f = deFarben();
  $("#de-legende").innerHTML = DE_STUFEN.map((s, i) => `<label style="cursor:default"><span class="dot" style="background:${f[i]}"></span>${s.name}<span class="n">${zahl(proStufe[i])}</span></label>`).join("");
  $("#de-datum").textContent = fmt(T);
  DE.ebene.zeichne();
}

function deTabelle() {
  const d = DE.daten, jahre = ["bis 2022", "2023", "2024", "2025", "2026"], laender = new Map();
  for (const p of d.zeilen) {
    if (!DE.quellen.has(p[3]) || !DE.typen.has(p[4])) continue;
    const land = d.laender[p[5]];
    if (!laender.has(land)) laender.set(land, { erst: p[2], j: jahre.map(() => 0), n: 0 });
    const l = laender.get(land);
    if (p[2] < l.erst) l.erst = p[2];
    l.j[stufeVon(+p[2].slice(0, 4))]++;
    if (p[4] === "N") l.n++;
  }
  const BL = ["Baden-Württemberg", "Bayern", "Berlin", "Brandenburg", "Bremen", "Hamburg", "Hessen", "Mecklenburg-Vorpommern", "Niedersachsen", "Nordrhein-Westfalen", "Rheinland-Pfalz", "Saarland", "Sachsen", "Sachsen-Anhalt", "Schleswig-Holstein", "Thüringen"];
  const zeilen = [...laender].filter(([l]) => BL.includes(l)).sort((a, b) => a[1].erst.localeCompare(b[1].erst));
  $("#de-tabelle").innerHTML = `<h3>Funde je Bundesland, sortiert nach erstem Nachweis</h3>
    <p class="erkl">Zählt die aktuell gewählten Quellen und Fundarten. Die Zahlen spiegeln auch, wo wie viel gemeldet wird: In NRW und Hessen fließen die Behördendaten ein, in den übrigen Ländern nur Bürgermeldungen über GBIF. Einzelne sehr frühe Funde können Einschleppungen sein.</p>
    <div class="tabwrap"><table><thead><tr><th>Bundesland</th><th>erster Fund</th>${jahre.map((j) => `<th>${j}</th>`).join("")}<th>davon Nester</th></tr></thead><tbody>
    ${zeilen.map(([l, v]) => `<tr><td>${esc(l)}</td><td>${fmtIso(v.erst)}</td>${v.j.map((x) => `<td>${x ? zahl(x) : "–"}</td>`).join("")}<td>${v.n ? zahl(v.n) : "–"}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function deKlick(ev) {
  const c = DE.karte.latLngToContainerPoint(ev.latlng);
  let best = null, bd = 64;
  for (const p of DE.punkte) { const dd = (p.x - c.x) ** 2 + (p.y - c.y) ** 2; if (dd <= bd) { bd = dd; best = p; } }
  if (!best) return;
  const d = DE.daten, quelle = d.quellen[best[3]];
  let link = "";
  if (quelle === "LANUK NRW" && best[4] === "N") link = `<a href="${LANUK_APP}${QUELLE.nest.ds}:${best[6]}" target="_blank" rel="noopener">In der LANUK-Karte öffnen ↗</a>`;
  else if (best[6] && quelle !== "LANUK NRW" && quelle !== "HLNUG Hessen") link = `<a href="https://www.gbif.org/occurrence/${best[6]}" target="_blank" rel="noopener">GBIF-Datensatz ↗</a>`;
  else if (quelle === "HLNUG Hessen") link = `<a href="https://www.hlnug.de/themen/naturschutz/tiere-und-pflanzen/arten-melden/hornisse/bisherige-funde-in-hessen" target="_blank" rel="noopener">HLNUG-Karte ↗</a>`;
  L.popup().setLatLng([best[0], best[1]]).setContent(`<b>${best[4] === "N" ? "Nest" : "Einzeltier / Sichtung"}</b><table>
    <tr><td>Fund</td><td>${fmtIso(best[2])}</td></tr><tr><td>Quelle</td><td>${esc(quelle)}</td></tr><tr><td>Land</td><td>${esc(d.laender[best[5]])}</td></tr></table>${link}`).openOn(DE.karte);
}

function deStop() { clearInterval(DE.timer); DE.timer = null; $("#de-play").textContent = "▶"; }
function deSetze(T) { DE.T = Math.max(DE.min, Math.min(T, HEUTE)); $("#de-zeit").value = DE.T; deFilter(); }

async function initDeutschland() {
  if (DE.karte) { DE.karte.invalidateSize(); return; }
  $("#de-datum").textContent = "lädt …";
  DE.daten = await fetch("data/deutschland.json", { cache: "no-cache" }).then((r) => r.json());
  for (const p of DE.daten.zeilen) { p.t = tagIdx(p[2]); p.stufe = stufeVon(+p[2].slice(0, 4)); }
  DE.daten.zeilen.sort((a, b) => a.t - b.t);
  DE.daten.quellen.forEach((_, i) => DE.quellen.add(i));
  DE.min = DE.daten.zeilen[0].t; DE.T = HEUTE;

  DE.karte = L.map("karte-de", { minZoom: 5 }).fitBounds([[47.3, 5.9], [55.0, 15.0]]);
  L.tileLayer(KACHELN, { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Daten: LANUK NRW, HLNUG Hessen, <a href="https://www.gbif.org/species/1311477">GBIF.org</a>', maxZoom: 16 }).addTo(DE.karte);
  DE.ebene = new PunktEbene().addTo(DE.karte);
  DE.karte.on("click", deKlick);

  const anzahlQuelle = DE.daten.quellen.map((_, i) => DE.daten.zeilen.filter((p) => p[3] === i).length);
  $("#de-quellen").innerHTML = DE.daten.quellen.map((q, i) => `<label><input type="checkbox" class="de-quelle" value="${i}" checked> ${esc(q)}<span class="n">${zahl(anzahlQuelle[i])}</span></label>`).join("");
  $$(".de-quelle").forEach((el) => el.onchange = () => { el.checked ? DE.quellen.add(+el.value) : DE.quellen.delete(+el.value); deFilter(); deTabelle(); });
  $$(".de-typ").forEach((el) => el.onchange = () => { el.checked ? DE.typen.add(el.value) : DE.typen.delete(el.value); deFilter(); deTabelle(); });
  $$('input[name="de-modus"]').forEach((el) => el.onchange = () => { DE.modus = el.value; deFilter(); });

  const z = $("#de-zeit"); z.min = DE.min; z.max = HEUTE; z.value = HEUTE;
  z.oninput = () => { deStop(); deSetze(+z.value); };
  const jahre = [...new Set(DE.daten.zeilen.map((p) => +p[2].slice(0, 4)))].filter((y) => y >= 2020);
  $("#de-sprung").innerHTML = `<option value="">Abspielen ab …</option><option value="${DE.min}">erster Fund</option>` + jahre.map((y) => `<option value="${Date.UTC(y, 0, 1) / TAG}">1.1.${y}</option>`).join("");
  $("#de-sprung").onchange = (ev) => { deStop(); if (ev.target.value !== "") deSetze(+ev.target.value); };
  $("#de-ende").onclick = () => { deStop(); $("#de-sprung").value = ""; deSetze(HEUTE); };
  $("#de-play").onclick = () => {
    if (DE.timer) return deStop();
    if (DE.T >= HEUTE) deSetze($("#de-sprung").value !== "" ? +$("#de-sprung").value : Date.UTC(2022, 0, 1) / TAG);
    $("#de-play").textContent = "⏸";
    DE.timer = setInterval(() => {
      if (DE.T >= HEUTE) return deStop();
      deSetze(DE.T + +$("#de-tempo").value);
    }, 160);
  };

  // Tabelle unter der Karte
  const tab = document.createElement("div");
  tab.id = "de-tabelle"; tab.className = "inhalt de-tabelle";
  $("#view-deutschland .kartenwrap").appendChild(tab);
  deFilter(); deTabelle();
}
