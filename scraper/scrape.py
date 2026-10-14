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

# Folgemeldung: Eine spätere, als entfernt markierte Meldung höchstens so weit
# entfernt gilt als Entfernung des früheren Nests (Stichprobe: meist dasselbe Nest).
PAAR_MAX_M = 20
PAAR_MAX_TAGE = 120

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


def verknuepfe_folgemeldungen(nester):
    """Nest ohne Entfernt-Angabe + spätere Entfernt-Meldung am selben Ort -> vermutlich entfernt."""
    raster = defaultdict(list)
    for b in nester:
        if b["kat"] == "nest" and b["ent"] in ("feld", "text"):
            raster[(int(b["lat"] * 500), int(b["lon"] * 500))].append(b)  # ~200 m Zellen
    kandidaten = []
    for a in nester:
        if a["kat"] != "nest" or a["ent"] not in ("?", "nein"):
            continue
        da = dt.date.fromisoformat(a["d"])
        ky, kx = int(a["lat"] * 500), int(a["lon"] * 500)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for b in raster.get((ky + dy, kx + dx), ()):
                    tage = (dt.date.fromisoformat(b["d"]) - da).days
                    if b["saison"] != a["saison"] or not 0 <= tage <= PAAR_MAX_TAGE:
                        continue
                    m = abstand_m(a["lat"], a["lon"], b["lat"], b["lon"])
                    if m <= PAAR_MAX_M:
                        kandidaten.append((m, tage, a, b))
    vergeben = set()
    for m, tage, a, b in sorted(kandidaten, key=lambda k: (k[0], k[1])):
        if a["id"] in vergeben or b["id"] in vergeben:
            continue
        vergeben |= {a["id"], b["id"]}
        datum_b = max(b["entd"] or b["d"], a["d"])
        a.update(ent="paar", entd=datum_b, entq="paar", paar=b["id"], paar_m=round(m))


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

    verknuepfe_folgemeldungen(nester)

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
        best = None
        ky, kx = int(lat * 50), int(lon * 50)
        for dy in range(-5, 6):  # ±5 Rasterzellen ≈ ±10 km
            for dx in range(-5, 6):
                for n in raster.get((d.year, ky + dy, kx + dx), ()):
                    m = abstand_m(lat, lon, n["lat"], n["lon"])
                    if best is None or m < best:
                        best = m
        einzel.append({
            "id": a["objectid"], "lat": round(lat, 5), "lon": round(lon, 5),
            "d": d.isoformat(), "saison": d.year, "frei": freigabe(a.get("freigabe")),
            "dn": round(best) if best is not None else None,  # Meter zum nächsten Nest, None = >10 km
        })

    OUT.mkdir(parents=True, exist_ok=True)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    schreibe(OUT / "nester.json", nester)
    schreibe(OUT / "einzeltiere.json", einzel)
    STATE.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    meta = {
        "stand": dt.datetime.now(TZ).isoformat(timespec="minutes"),
        "anzahl": {"nester": len(roh_n), "einzeltiere": len(roh_e), "gesamt": len(roh_g)},
        "saison_start_monat": SAISON_START_MONAT,
        "sekundaer_ab_monat": SEKUNDAER_AB_MONAT,
        "quelle": f"{BASE} (LANUK NRW)",
    }
    schreibe(OUT / "meta.json", meta, kompakt=False)

    c = Counter((n["kat"], n["typ"], n["stufe"]) for n in nester)
    print(f"Nester: {len(nester)}, Einzeltiere: {len(einzel)}")
    for k, v in sorted(c.items(), key=lambda x: -x[1]):
        print("  ", k, v)
    print("Entfernt:", Counter(n["ent"] for n in nester if n["kat"] == "nest"))


def schreibe(pfad, daten, kompakt=True):
    pfad.write_text(json.dumps(daten, ensure_ascii=False,
                               separators=(",", ":") if kompakt else None,
                               indent=None if kompakt else 2))


if __name__ == "__main__":
    main()
