"""Lädt die Meldungen zur Asiatischen Hornisse aus den öffentlichen ArcGIS-Diensten
des LANUK NRW, ordnet die Nester ein und schreibt reduzierte JSON-Dateien für die Karte.

Freitexte (Bemerkung, Fundort, Beseitigungstext) werden nur hier ausgewertet und
nie in die Ausgabe geschrieben, weil sie teils Namen und Adressen enthalten.

Aufruf: python scraper/scrape.py  (nur Standardbibliothek, Python >= 3.9)
"""
import datetime as dt
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://www.arcgishostedserver.nrw.de/arcgis/rest/services/Hosted"
LAYER_NESTER = "Sicht_Vespa_velutina"
LAYER_EINZEL = "Sicht_Vespa_velutina_Einzeltiere"
LAYER_GESAMT = "erfassungen_neobiota_sichtlayer_public"  # enthält beseitigt / bes_txt

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data"
STATE = ROOT / "data" / "state.json"

TZ = ZoneInfo("Europe/Berlin")

# Nester ohne Königin-/Primärhinweis, die vor diesem Monat gefunden wurden,
# zählen zur Vorjahressaison (Winterfunde alter Nester nach dem Laubfall).
SAISON_START_MONAT = 4

# Ab diesem Fundmonat gelten kleine Nester (≤ 100 Tiere oder ohne Schätzung)
# als Sekundärnest. Davor (ab Juli) bleiben sie "unklar". Siehe Statistik-Seite,
# Abschnitt "Prüfung der Datumsregel".
SEKUNDAER_AB_MONAT = 8

# Doppelmeldungen: Eine Nestmeldung höchstens so weit und so lange nach der ersten
# Meldung eines Nests (gleiche Saison) gilt als dasselbe Nest und wird zusammengeführt.
# Stichprobe: ~3/4 solcher Paare sind wirklich dasselbe Nest.
DOPPEL_MAX_M = 20
DOPPEL_MAX_TAGE = 120

# Weitere Sichtungen aus GBIF (NABU|naturgucker, Observation.org, iNaturalist, ArtenFinder)
GBIF_API = "https://api.gbif.org/v1/occurrence/search"
GBIF_TAXON = 1311477          # Vespa velutina
GBIF_GADM = "DEU.10_1"        # Nordrhein-Westfalen
GBIF_MAX_UNSICHER_M = 2000    # ungenauere Koordinaten weglassen
GBIF_QUELLEN = {
    "6ac3f774-d9fb-4796-b3e9-92bf6c81c084": "NABU|naturgucker",
    "8a863029-f435-446a-821e-275f4f641165": "Observation.org",
    "50c9509d-22c7-4a22-a47d-8c48425ef4a7": "iNaturalist",
    "aa6c5ee6-d4d7-4a65-a04f-379cffbf4842": "ArtenFinder",
}


def lizenz_kurz(url):
    if "by-nc" in url:
        return "CC BY-NC 4.0"
    if "/by/" in url:
        return "CC BY 4.0"
    if "zero" in url:
        return "CC0"
    return url or "unbekannt"

# Abbruch, wenn eine Quelle plötzlich deutlich weniger Datensätze liefert
# (z. B. weil der Dienst umgebaut wurde) – lieber laut scheitern als leere Karte.
MAX_SCHWUND = 0.2

IND_KLEIN = {"1 Ind.", "2-5 Ind.", "6-10 Ind.", "11-20 Ind.", "21-50 Ind.",
             "51-100 Ind.", "6-25 Ind.", "26-100 Ind."}
IND_GROSS = {"> 1000 Ind.", "> 10000 Ind."}

RE_PRIM = re.compile(r"prim[äa]r|embry", re.I)
RE_SEK = re.compile(r"sekund[äa]r", re.I)
RE_ENTF = re.compile(
    r"entfernt|beseitigt|getilgt|tilgung|abgesaugt|absaugung|abgetötet|abgetoetet|"
    r"entnommen|vernichtet|eliminiert|bekämpft|bekaempft|unschädlich|abgenommen|"
    r"eingefroren|abgeflammt", re.I)
# Hinweise darauf, dass die Entfernung (noch) nicht passiert ist
RE_NICHT = re.compile(
    r"\bnicht\b|\bkein|\bsoll|\bsollte|\bwerden\b|\bgeplant|\bnoch\b|\bdemnächst|"
    r"\bmorgen\b|\bwird\b(?!.*\b(wurde|ist)\b)", re.I)
RE_DATUM = re.compile(r"\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})?")


def hole(layer, where="1=1"):
    """Alle Datensätze einer Ebene seitenweise laden (max. 1000 pro Abfrage)."""
    alle, offset = [], 0
    while True:
        q = urllib.parse.urlencode(dict(
            where=where, outFields="*", returnGeometry="true", outSR=4326,
            resultOffset=offset, resultRecordCount=1000, orderByFields="objectid", f="json"))
        url = f"{BASE}/{layer}/FeatureServer/0/query?{q}"
        for versuch in range(4):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    d = json.load(r)
                break
            except Exception:
                if versuch == 3:
                    raise
                time.sleep(5 * (versuch + 1))
        if "error" in d:
            raise RuntimeError(f"{layer}: {d['error']}")
        fs = d["features"]
        alle += fs
        offset += len(fs)
        if not d.get("exceededTransferLimit") and len(fs) < 1000:
            return alle


def datum(ms):
    if ms is None:
        return None
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).astimezone(TZ).date()


def freigabe(wert):
    # "fa" taucht seit Juli 2026 bei fast allen Einzeltieren auf – offenbar eine
    # automatische Freigabe, kein "ausstehend" (das heißt bei Nestern "nb").
    if wert == "fa":
        return "ja"
    if wert == "freigegeben" or (wert or "").startswith("akzeptiert") or wert == "automatisch akzeptiert":
        return "ja"
    if wert in ("nicht freigegeben", "abgelehnt"):
        return "nein"
    return "offen"


def ordne_nest_ein(a, d):
    """Liefert (typ, regel, stufe). typ: P/S/U, stufe: g=gesichert, d=nach Datum, u=unklar."""
    text = " ".join(filter(None, [a.get("bemerkung"), a.get("stadium"), a.get("fundort")]))
    p, s = bool(RE_PRIM.search(text)), bool(RE_SEK.search(text))
    if p != s:
        return ("P" if p else "S", "text", "g")
    ind, m = a.get("individuen"), d.month
    if ind in IND_GROSS:
        return ("S", "gt1000", "g")
    if 4 <= m <= 6 and ind in IND_KLEIN:
        return ("P", "fj_le100", "g")
    if m >= 7 and ind == "> 100 Ind.":
        return ("S", "so_gt100", "g")
    # ab hier nur noch über den Meldezeitpunkt
    if m < SAISON_START_MONAT:
        if "königin" in (a.get("stadium") or "").lower():
            return ("P", "fj_koenigin", "d")
        return ("S", "winter", "d")
    if 4 <= m <= 6 and ind not in ("> 100 Ind.",):
        return ("P", "fj_datum", "d")
    if m >= SEKUNDAER_AB_MONAT:
        return ("S", "ab_aug", "d")
    return ("U", "rest", "u")


def entfernung_aus_text(texte, fund):
    """(entfernt?, datum) aus Freitexten. Ein Satz zählt nur ohne Verneinung/Zukunft."""
    treffer, datum_ = False, None
    for t in texte:
        for satz in re.split(r"(?<=[.!?;,])\s+|\n", t or ""):
            if RE_ENTF.search(satz) and not RE_NICHT.search(satz):
                treffer = True
                if datum_ is None:
                    datum_ = datum_im_satz(satz, fund)
    return treffer, datum_


def datum_im_satz(satz, fund):
    for m in RE_DATUM.finditer(satz):
        tag, monat, jahr = int(m[1]), int(m[2]), m[3]
        jahr = int(jahr) if jahr else fund.year
        if jahr < 100:
            jahr += 2000
        try:
            d = dt.date(jahr, monat, tag)
        except ValueError:
            continue
        if -5 <= (d - fund).days <= 200:
            return d
    return None


def abstand_m(lat1, lon1, lat2, lon2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 6371000 * math.hypot(x, math.radians(lat2 - lat1))


STUFE_RANG = {"g": 2, "d": 1, "u": 0}
IND_RANG = {k: i for i, k in enumerate(["1 Ind.", "2-5 Ind.", "6-10 Ind.", "6-25 Ind.", "11-20 Ind.",
                                         "21-50 Ind.", "26-100 Ind.", "51-100 Ind.", "> 100 Ind.",
                                         "> 1000 Ind.", "> 10000 Ind."])}


def fuehre_doppelmeldungen_zusammen(nester):
    """Fasst Mehrfachmeldungen desselben Nests zu einem Eintrag zusammen."""
    andere = [n for n in nester if n["kat"] != "nest"]
    gruppen, raster = [], defaultdict(list)
    for n in sorted((n for n in nester if n["kat"] == "nest"), key=lambda n: (n["d"], n["id"])):
        d = dt.date.fromisoformat(n["d"])
        ky, kx = int(n["lat"] * 500), int(n["lon"] * 500)  # ~200 m Zellen
        beste = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for g in raster.get((ky + dy, kx + dx), ()):
                    a = g[0]
                    if a["saison"] != n["saison"] or (d - dt.date.fromisoformat(a["d"])).days > DOPPEL_MAX_TAGE:
                        continue
                    m = abstand_m(a["lat"], a["lon"], n["lat"], n["lon"])
                    if m <= DOPPEL_MAX_M and (beste is None or m < beste[0]):
                        beste = (m, g)
        if beste:
            beste[1].append(n)
        else:
            g = [n]
            gruppen.append(g)
            raster[(ky, kx)].append(g)
    return andere + [vereinige(g) for g in gruppen]


def vereinige(g):
    erste = g[0]
    if len(g) == 1:
        erste["ids"] = [erste["id"]]
        return erste
    n = dict(erste)
    n["ids"] = [x["id"] for x in g]
    # Typ: die am besten belegte Einordnung, bei Gleichstand die späteste Meldung
    typ_von = max(g, key=lambda x: (STUFE_RANG[x["stufe"]], x["d"]))
    n.update(typ=typ_von["typ"], regel=typ_von["regel"], stufe=typ_von["stufe"])
    inds = [x["ind"] for x in g if x["ind"]]
    n["ind"] = max(inds, key=lambda i: IND_RANG.get(i, -1)) if inds else None
    n["frei"] = "ja" if any(x["frei"] == "ja" for x in g) else "offen" if any(x["frei"] == "offen" for x in g) else "nein"
    n["m"] = min(x["m"] for x in g)
    # Entfernt: früheste bekannte Entfernung; eine spätere Entfernt-Meldung datiert über ihr Funddatum
    weg = [x for x in g if x["ent"] in ("feld", "text")]
    if weg:
        n["ent"] = weg[0]["ent"]
        daten = []
        for x in weg:
            if x["entd"]:
                daten.append((x["entd"], x["entq"], x["id"]))
            elif x is not erste:
                daten.append((x["d"], "folge", x["id"]))
        if daten:
            entd, entq, quelle = min(daten)
            n.update(entd=max(entd, erste["d"]), entq=entq, ent_id=quelle)
        else:
            n.update(entd=None, entq=None)
    elif any(x["ent"] == "nein" for x in g):
        n["ent"] = "nein"
    return n


def hole_json(url):
    for versuch in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception:
            if versuch == 3:
                raise
            time.sleep(5 * (versuch + 1))


def hole_gbif(heute):
    """Alle Vespa-velutina-Funde in NRW aus GBIF, reduziert auf Ort, Datum, Quelle und Link."""
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode(dict(
            taxonKey=GBIF_TAXON, gadmGid=GBIF_GADM, hasCoordinate="true", hasGeospatialIssue="false",
            occurrenceStatus="PRESENT", limit=300, offset=offset))
        d = hole_json(f"{GBIF_API}?{q}")
        for r in d["results"]:
            unsicher = r.get("coordinateUncertaintyInMeters")
            ed = (r.get("eventDate") or "")[:10]
            if not ed or len(ed) < 10 or (unsicher and unsicher > GBIF_MAX_UNSICHER_M):
                continue
            try:
                tag = dt.date.fromisoformat(ed)
            except ValueError:
                continue
            if tag > heute or tag.year < 2014:
                continue
            ref = r.get("references") or ""
            out.append({
                "id": r["gbifID"], "lat": round(r["decimalLatitude"], 5), "lon": round(r["decimalLongitude"], 5),
                "d": tag.isoformat(), "saison": tag.year,
                "q": GBIF_QUELLEN.get(r.get("datasetKey"), r.get("datasetName") or "GBIF"),
                "lic": lizenz_kurz(r.get("license", "")),
                "url": ref if ref.startswith("http") else None,
            })
        offset += len(d["results"])
        if d.get("endOfRecords") or not d["results"]:
            return out


def naechstes_nest(raster, saison, lat, lon):
    best = None
    ky, kx = int(lat * 50), int(lon * 50)
    for dy in range(-5, 6):  # ±5 Rasterzellen ≈ ±10 km
        for dx in range(-5, 6):
            for n in raster.get((saison, ky + dy, kx + dx), ()):
                m = abstand_m(lat, lon, n["lat"], n["lon"])
                if best is None or m < best:
                    best = m
    return round(best) if best is not None else None


def pruefe_schwund(name, anzahl, vorher):
    alt = vorher.get("anzahl", {}).get(name)
    if alt and anzahl < alt * (1 - MAX_SCHWUND):
        sys.exit(f"ABBRUCH: {name} liefert {anzahl} statt bisher {alt} Datensätze – Quelle prüfen.")


def main():
    heute = dt.datetime.now(TZ).date()
    vorher = json.loads((OUT / "meta.json").read_text()) if (OUT / "meta.json").exists() else {}
    state = json.loads(STATE.read_text()) if STATE.exists() else {}

    roh_n = hole(LAYER_NESTER)
    roh_e = hole(LAYER_EINZEL)
    roh_g = hole(LAYER_GESAMT, "art LIKE 'Asiat%Hornisse%'")
    for name, liste in (("nester", roh_n), ("einzeltiere", roh_e), ("gesamt", roh_g)):
        pruefe_schwund(name, len(liste), vorher)
    gesamt = {f["attributes"]["globalid"]: f["attributes"] for f in roh_g}

    nester = []
    for f in roh_n:
        a, g = f["attributes"], f.get("geometry") or {}
        d = datum(a.get("funddatum"))
        if d is None or "x" not in g:
            continue
        if d > heute:  # Tippfehler im Funddatum (liegt in der Zukunft)
            d = datum(a.get("created_date")) or heute
        gid = a["globalid"]
        z = gesamt.get(gid, {})
        stadium = (a.get("stadium") or "").lower()
        # Das alte Formular (2023) kennt kein "Nest", nur den Inhalt (Eier/Larven/Puppen).
        if re.search(r"nest|eier|larve|puppe", stadium):
            kat = "nest"
            typ, regel, stufe = ordne_nest_ein(a, d)
        else:
            kat, typ, regel, stufe = "koenigin", None, None, None
        if typ == "P" or kat == "koenigin":
            saison = d.year
        else:
            saison = d.year - 1 if d.month < SAISON_START_MONAT else d.year

        # Entfernt? Feld schlägt Freitext; Datum aus Text, sonst aus eigener Beobachtung.
        feld = z.get("beseitigt")
        texte = [a.get("bemerkung"), z.get("bes_txt") if feld != "nein" else None]
        im_text, ent_datum = entfernung_aus_text(texte, d)
        if feld == "ja":
            ent = "feld"
        elif im_text:
            ent = "text"
        elif feld == "nein":
            ent = "nein"
        else:
            ent = "?"
        ent_quelle = "text" if ent_datum else None

        s = state.get(gid)
        if s is None:
            s = state[gid] = {"erst": heute.isoformat() if vorher else None, "ent": ent}
            # Neue Meldung, die schon beim ersten Abruf als entfernt markiert ist:
            # dann war das Nest bei der Meldung bereits weg.
            meldung = datum(a.get("created_date"))
            if vorher and ent in ("feld", "text") and meldung and (heute - meldung).days <= 2:
                s["ent_meldung"] = meldung.isoformat()
        elif s.get("ent") in ("nein", "?") and ent in ("feld", "text"):
            s["ent"], s["ent_beob"] = ent, heute.isoformat()
        if not ent_datum and s.get("ent_meldung"):
            ent_datum, ent_quelle = dt.date.fromisoformat(s["ent_meldung"]), "meldung"
        if not ent_datum and s.get("ent_beob"):
            ent_datum, ent_quelle = dt.date.fromisoformat(s["ent_beob"]), "beob"

        nester.append({
            "id": a["objectid"],
            "lat": round(g["y"], 5), "lon": round(g["x"], 5),
            "d": d.isoformat(),
            "m": (datum(a.get("created_date")) or d).isoformat(),
            "kat": kat, "typ": typ, "regel": regel, "stufe": stufe,
            "saison": saison,
            "ind": a.get("individuen") if a.get("individuen") not in (None, "", "keine Angabe") else None,
            "ent": ent,
            "entd": ent_datum.isoformat() if ent_datum else None,
            "entq": ent_quelle,
            "frei": freigabe(a.get("freigabe")),
            "kreis": a.get("kreis"), "gem": a.get("gemeinde"),
        })

    roh_anzahl = sum(1 for n in nester if n["kat"] == "nest")
    nester = fuehre_doppelmeldungen_zusammen(nester)
    print(f"Doppelmeldungen: {roh_anzahl} Nestmeldungen -> {sum(1 for n in nester if n['kat'] == 'nest')} Nester")

    # Einzeltiere mit Abstand zum nächsten bekannten Nest derselben Saison
    raster = defaultdict(list)
    for n in nester:
        if n["kat"] == "nest":
            raster[(n["saison"], int(n["lat"] * 50), int(n["lon"] * 50))].append(n)
    einzel = []
    for f in roh_e:
        a, g = f["attributes"], f.get("geometry") or {}
        d = datum(a.get("funddatum"))
        if d is None or "x" not in g or d > heute:
            continue
        lat, lon = g["y"], g["x"]
        best = naechstes_nest(raster, d.year, lat, lon)
        einzel.append({
            "id": a["objectid"], "lat": round(lat, 5), "lon": round(lon, 5),
            "d": d.isoformat(), "saison": d.year, "frei": freigabe(a.get("freigabe")),
            "dn": best,  # Meter zum nächsten Nest, None = >10 km
        })

    # GBIF: bei Fehler den letzten Stand behalten, LANUK-Aktualisierung nicht gefährden
    gbif = None
    try:
        gbif = hole_gbif(heute)
        alt = vorher.get("anzahl", {}).get("gbif")
        if alt and len(gbif) < alt * (1 - MAX_SCHWUND):
            print(f"WARNUNG: GBIF liefert {len(gbif)} statt {alt} – behalte alten Stand.")
            gbif = None
    except Exception as e:
        print("WARNUNG: GBIF nicht erreichbar:", e)
    if gbif is not None:
        # Gleiche Beobachtung schon bei LANUK? (≤ 50 m, ±3 Tage)
        lanuk = defaultdict(list)
        for x in einzel + [n for n in nester if n["kat"] == "nest"]:
            lanuk[(int(x["lat"] * 200), int(x["lon"] * 200))].append(x)
        for r in gbif:
            r["dn"] = naechstes_nest(raster, r["saison"], r["lat"], r["lon"])
            tag = dt.date.fromisoformat(r["d"])
            ky, kx = int(r["lat"] * 200), int(r["lon"] * 200)
            r["lanuk"] = any(
                abstand_m(r["lat"], r["lon"], x["lat"], x["lon"]) <= 50 and abs((dt.date.fromisoformat(x["d"]) - tag).days) <= 3
                for dy in (-1, 0, 1) for dx in (-1, 0, 1) for x in lanuk.get((ky + dy, kx + dx), ()))

    OUT.mkdir(parents=True, exist_ok=True)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    schreibe(OUT / "nester.json", nester)
    schreibe(OUT / "einzeltiere.json", einzel)
    if gbif is not None:
        schreibe(OUT / "gbif.json", gbif)
    STATE.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    meta = {
        "stand": dt.datetime.now(TZ).isoformat(timespec="minutes"),
        "anzahl": {"nester": len(roh_n), "einzeltiere": len(roh_e), "gesamt": len(roh_g),
                   "gbif": len(gbif) if gbif is not None else vorher.get("anzahl", {}).get("gbif")},
        "saison_start_monat": SAISON_START_MONAT,
        "sekundaer_ab_monat": SEKUNDAER_AB_MONAT,
        "quelle": f"{BASE} (LANUK NRW)",
    }
    schreibe(OUT / "meta.json", meta, kompakt=False)

    c = Counter((n["kat"], n["typ"], n["stufe"]) for n in nester)
    print(f"Nester: {len(nester)}, Einzeltiere: {len(einzel)}, GBIF: {len(gbif) if gbif is not None else 'alter Stand'}")
    if gbif:
        print("  GBIF-Quellen:", Counter(r["q"] for r in gbif), "| auch bei LANUK:", sum(r["lanuk"] for r in gbif))
    for k, v in sorted(c.items(), key=lambda x: -x[1]):
        print("  ", k, v)
    print("Entfernt:", Counter(n["ent"] for n in nester if n["kat"] == "nest"))


def schreibe(pfad, daten, kompakt=True):
    pfad.write_text(json.dumps(daten, ensure_ascii=False,
                               separators=(",", ":") if kompakt else None,
                               indent=None if kompakt else 2))


if __name__ == "__main__":
    main()
