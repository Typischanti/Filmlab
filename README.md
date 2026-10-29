# FilmLab – Negativ-Konverter

Lokale Desktop-Anwendung zur Umwandlung digitalisierter Filmnegative
(Kamera-Scan oder Scanner) in hochwertige Positive. Die gesamte Verarbeitung
läuft in linearer float32-Präzision, ohne 8-Bit-Zwischenschritte.

* **Farbnegativ (C-41)**, **S/W-Negativ**, **Diafilm** (Positiv-Workflow)
* Dichtebasierte Inversion mit kanalweiser **Orangemasken-Kompensation**
  (physikalisch hergeleitet, siehe [docs/ALGORITHM.md](docs/ALGORITHM.md))
* Automatische **Filmgrund-Erkennung** an Filmrand und Stegen zwischen den
  Bildern (Perforation/Durchlicht wird verworfen), Erkennung und Ausschluss
  des schwarzen **Filmhalters**, automatischer Zuschnitt auf das Bild,
  manueller Messbereich, Plausibilitätsprüfung, gekennzeichnete Ersatzschätzung
* Import: DNG, NEF, CR2, CR3, ARW, RAF, ORF, RW2 … (LibRaw), TIFF 8/16/32 Bit, PNG 8/16 Bit, JPEG
* Export: **TIFF 16 Bit**, PNG 8/16 Bit, JPEG (Qualitätsregler), jeweils mit
  eingebettetem ICC-Profil (sRGB, Adobe-RGB-kompatibel, ProPhoto, Rec. 2020, linear)
* Live-Vorschau mit Zoom/Pan, Vorher/Nachher, Split-View, Histogramm, Zuschnitt
* Regler für Belichtung, Kontrast, Helligkeit, Gamma, Temperatur/Tint,
  Neutralpunkt, Schwarz-/Weißwert, Lichter/Tiefen, Lichterschulter,
  Sättigung, Dynamik, RGB- und Einzelkanal-Kurven, Schärfung,
  Rauschreduzierung, Rotation (90° und fein), Spiegeln
* Filmprofile und Presets als **JSON** (Neutral, Classic Film, Portrait,
  Landscape, Flat), eigene Presets speicherbar
* Filmstreifen, **Stapel-Export**, Einstellungen synchronisieren,
  **Filmstreifen-Analyse** (konsistente Entwicklung eines ganzen Films)
* Nicht-destruktiv: Undo/Redo, Projektdateien (`.filmlab`), automatische
  Sitzungswiederherstellung; Originale werden nie verändert

## Installation

Voraussetzung: Python **3.12 oder neuer**.

```bash
git clone <repo> && cd Filmlab
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev]"              # oder: pip install -r requirements-dev.txt
```

Getestete Versionen: numpy 2.5, opencv-python-headless 5.0, rawpy 0.27
(LibRaw 0.22), tifffile 2026.10, imagecodecs 2026.10, Pillow 13.0
(LittleCMS 2.19), PySide6 6.12, pytest 9.2.

**Linux**: PySide6 benötigt System-Bibliotheken für OpenGL/EGL und xkb. Auf
Debian/Ubuntu z. B.: `sudo apt install libegl1 libgl1 libxkbcommon0 libfontconfig1 libdbus-1-3`.

## Start

```bash
python -m filmlab                     # Oberfläche (stellt letzte Sitzung wieder her)
python -m filmlab scan1.dng scan2.dng # mit Dateien
python -m filmlab film.filmlab        # Projekt öffnen
filmlab                               # nach pip install -e .
```

Ein synthetisches Testnegativ (mit Filmrand und Perforation) erzeugen:

```bash
python -m filmlab.cli demo -o samples
python -m filmlab samples/synthetic_negative.tif
```

> Das Demo-TIFF ist **linear** kodiert: in der Oberfläche unter
> *Filmgrund → Eingangsdaten* „Linear“ wählen.

## Bedienung

1. **Bilder öffnen** (Strg+O oder Drag & Drop). Miniaturen erscheinen im
   Filmstreifen; die Analyse läuft im Hintergrund.
2. **Filmtyp** und **Filmprofil** links wählen, dann ein **Preset**.
3. **Filmgrund** (rechts): Quelle *Automatisch* findet den Filmrand. Das
   Farbfeld zeigt die gemessene Maske, darunter Konfidenz und Hinweise. Bei
   Problemen *Bereich wählen* und ein Rechteck auf den unbelichteten Rand
   ziehen (die Ansicht zeigt dafür das Negativ). Feinkorrektur über
   *Maske R/G/B (ΔD)*.
4. **Zuschnitt**: *Bildbereich* übernimmt den automatisch erkannten Bereich
   ohne Filmrand; *Zuschneiden* erlaubt freies Anpassen.
5. **Weißabgleich**: *Neutralpunkt wählen* und auf eine graue Fläche klicken
   oder Temperatur/Tint verwenden.
6. **Export**: Format, Farbraum, Dateiname (`{name} {index:03d} {profile}
   {preset} {film} {date}`) und Ordner wählen → *Bild exportieren*.
7. **Ganzer Film**: Bilder im Filmstreifen markieren (Strg/Umschalt+Klick),
   *Filmstreifen-Analyse* für konsistente Entwicklung, *Einstellungen
   synchronisieren* zum Übertragen des Looks, *Stapel-Export*.

Tastatur: Strg+Z / Strg+Umschalt+Z Undo/Redo · `\` Vorher/Nachher ·
Strg+1/2/3 Nachher/Vorher/Split · F Einpassen · 1 Zoom 1:1 · Mausrad Zoom ·
Ziehen/Leertaste Verschieben · Doppelklick auf Reglerbeschriftung: Reset ·
Strg+Umschalt+C/V Einstellungen kopieren/einfügen · Strg+E Export.

## Kommandozeile

```bash
python -m filmlab.cli profiles
python -m filmlab.cli analyze scan.dng
python -m filmlab.cli convert *.NEF -o out/ --profile kodak_portra_400 --roll
python -m filmlab.cli convert scan.tif -o out/ --format jpeg --quality 92 --space adobe_rgb
```

## Profile und Presets anpassen

Eingebaute Dateien liegen in `filmlab/resources/profiles` und
`filmlab/resources/presets`. Eigene Dateien in `~/.filmlab/profiles/` bzw.
`~/.filmlab/presets/` ergänzen oder überschreiben diese (gleiche `id`).

```json
{
  "id": "mein_film",
  "name": "Mein Film 400",
  "film_type": "color_negative",
  "film": {"film_gamma": 0.62, "normalization": "auto"},
  "look_delta": {"contrast": -5, "saturation": 4},
  "recommended_preset": "neutral",
  "basis": "Woher stammen die Werte?"
}
```

`film` setzt filmbezogene Parameter, `look_delta` wird *additiv* zum
gewählten Preset gerechnet. Presets enthalten absolute Werte unter `look`.
Die mitgelieferten Profile enthalten **keine gemessenen Filmkennlinien**,
sondern dokumentierte Ausgangswerte (Feld `basis`).

## Projektstruktur

```
filmlab/
  core/        colorspace (Matrizen, Transferfunktionen), icc (Profil-Writer),
               settings (Einstellungsmodell), profiles, project (Projekt, Undo)
  imaging/     loader (RAW/TIFF/PNG/JPEG), filmbase (Maskenerkennung),
               inversion (Dichte, Normierung), tone, detail, geometry,
               pipeline (Analyse + Rendering), export, batch, fastops, synthetic
  ui/          main_window, viewer, panels, filmstrip, widgets, workers, theme
  resources/   profiles/*.json, presets/*.json
  cli.py       Kommandozeile
tests/         pytest-Suite
docs/          ALGORITHM.md – mathematische Grundlagen
```

## Tests

```bash
pytest -q
```

Die Suite (95 Tests) prüft u. a. die exakte Inversion synthetischer Negative,
die Unabhängigkeit des Ergebnisses von Maske und Lichtquelle, die
Filmrand-Erkennung (inkl. Perforation, Rauschen, fehlendem Rand), die
Plausibilitätsprüfungen, die numerische Stabilität, Schwarz-/Weißpunkte, die
Monotonie aller Tonkurven, 16-Bit-Präzision und Verläufe ohne Abrisse,
ICC-Profile gegen LittleCMS, die Konsistenz von Vorschau und Export, die
Übereinstimmung des schnellen Pfads mit der Referenz, die Reproduzierbarkeit
und Fehlerisolierung im Stapel, den RAW-Import (erzeugtes Bayer-DNG über
LibRaw) sowie einen End-to-End-Durchlauf der Oberfläche (offscreen).

## Leistung

Gemessen auf 4 CPU-Kernen: Vorschau 1800 px ≈ 0.2 s bei reiner Tonwert-
änderung (während des Ziehens Entwurf mit 900 px), Analyse ≈ 0.35 s,
Export eines 24-MP-Bildes ≈ 4–5 s. Das Rendering läuft in einem Hintergrund-
Thread; neue Anfragen ersetzen wartende.

## Einschränkungen

* **Eingebettete ICC-Profile** von 16-Bit-TIFFs werden nicht ausgewertet
  (es wird sRGB oder linear angenommen, wählbar). Bei 8-Bit-JPEGs werden sie
  über LittleCMS nach sRGB konvertiert.
* Die **Bildschirmanzeige** wird als sRGB ausgegeben (kein Monitorprofil).
* **1:1-Zoom** zeigt die Vorschauauflösung (1800 px), nicht die volle
  Auflösung; Schärfung und Rauschreduzierung beurteilt man am besten am Export.
* Zuschnitt mit freiem Seitenverhältnis (keine Vorgaben wie 3:2).
* **Filmrand-Erkennung** ist eine Heuristik. Sie erwartet einen gleichmäßigen
  unbelichteten Rand entlang einer Kante; bei sehr schmalen oder fehlenden
  Rändern wird eine gekennzeichnete Schätzung verwendet.
* Die kanalweise Normierung setzt neutrale Tiefen und Lichter im Motiv voraus;
  für Motive ohne neutrales Schwarz gibt es die filmgrund-referenzierte
  Normierung (siehe ALGORITHM.md).
* **Kamera-JPEGs sind nicht linear**: die kamerainterne Tonkurve verfälscht
  die Dichteberechnung kanalweise. Die Auto-Balance gleicht das in den
  Mitteltönen weitgehend aus, für beste Ergebnisse RAW (oder lineare
  16-Bit-TIFFs) verwenden.
* Validiert an synthetischen Negativen, einem erzeugten Bayer-DNG und
  11 realen Kamera-Scans (JPEG, Kodak Portra 400/160, Mittelformat, ein
  S/W-Film, schwarzer Filmhalter). Eine Validierung mit echten RAW-Dateien
  steht noch aus.
* Der Bildbereich wird für das Bild in der Bildmitte erkannt.
