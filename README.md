# Asiatische Hornisse NRW – eigene Karte

Karte, Zeitleiste, Jahresvergleich und Statistik der Meldungen zur Asiatischen Hornisse
(*Vespa velutina*) in NRW. Datenquelle sind die öffentlichen ArcGIS-Dienste hinter der
[Karte des LANUK](https://neobiota.naturschutzinformationen.nrw.de/neobiota/de/fundpunkte/karte_asiatische_hornisse).

## Aufbau

- `scraper/scrape.py` – lädt die Daten, ordnet Nester ein und schreibt `docs/data/*.json`
  (nur Python-Standardbibliothek). Freitexte werden nur ausgewertet, nie gespeichert.
- `docs/` – die Karte (statische Seite, wird über GitHub Pages ausgeliefert).
- `data/state.json` – merkt sich pro Meldung, wann der Scraper sie erstmals gesehen hat
  und wann sie erstmals als entfernt markiert war (für nachträgliche Entfernungen).
- `.github/workflows/aktualisieren.yml` – lädt die Daten täglich neu und committet sie.

## Lokal ansehen

```sh
python3 scraper/scrape.py                 # Daten aktualisieren
python3 -m http.server -d docs 8765       # dann http://localhost:8765 öffnen
```

## Einstellungen

Oben in `scraper/scrape.py`:

- `SAISON_START_MONAT` (4): Nester ohne Königin, die vor diesem Monat gefunden wurden,
  zählen zur Vorjahressaison.
- `SEKUNDAER_AB_MONAT` (8): ab diesem Fundmonat gelten kleine Nester ohne weitere
  Angaben als Sekundärnest, davor ab Juli als „unklar“.

## Einordnung der Nester

Die erste passende Regel gilt:

1. Freitext nennt Primär-/Embryonal- bzw. Sekundärnest – *gesichert*
2. Schätzung > 1.000 Tiere → Sekundärnest – *gesichert*
3. April–Juni, Schätzung ≤ 100 → Primärnest – *gesichert*
4. ab Juli, Schätzung > 100 → Sekundärnest – *gesichert*
5. April–Juni ohne Schätzung → Primärnest – *nach Meldedatum*
6. Januar–März mit Königin → Primärnest – *nach Meldedatum*
7. ab `SEKUNDAER_AB_MONAT`, klein oder ohne Schätzung → Sekundärnest – *nach Meldedatum*
8. Januar–März ohne Königin → Sekundärnest der Vorsaison – *nach Meldedatum*
9. Rest (Juli bis vor dem Stichmonat) → *unklar*

Einträge der Nester-Ebene ohne Nest im Stadium (nur „Königin“) werden als eigene
Kategorie „Königin (ohne Nestangabe)“ geführt.
