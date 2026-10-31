# Filmlab – Negativ-Konverter

Filmlab wandelt gescannte Filmnegative in natürliche Positive um – mit schönem,
nicht übertriebenem Kontrast und satten, aber glaubwürdigen Farben. Dazu kommen
professionelle Werkzeuge zur Bildbearbeitung. Alles läuft lokal im Browser,
es werden keine Bilder hochgeladen.

## Starten

Die App ist eine statische Webseite ohne Abhängigkeiten. Wegen der
JavaScript-Module braucht sie einen lokalen Webserver:

```bash
python3 -m http.server 8000      # oder: npx serve
# dann http://localhost:8000 öffnen
```

Über „Beispiel-Negativ laden“ lässt sich die App sofort ausprobieren.
Mit dem Workflow `.github/workflows/pages.yml` kann sie auf GitHub Pages
veröffentlicht werden (Settings → Pages → Source: „GitHub Actions“).

## Filmkamera (iPhone-App)

Im Ordner `camera/` liegt eine Kamera-App mit Filmemulation, gedacht als
Web-App für den Home-Bildschirm des iPhones (kein Mac und kein App Store
nötig). Sie wird zusammen mit Filmlab veröffentlicht und ist dann unter
`…/camera/` erreichbar.

**Installieren:** Die Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“.
Danach startet sie im Vollbild wie eine normale App und funktioniert auch
offline. Kamera und Lagesensor fragt sie beim ersten Start ab.

**Funktionen**
- Live-Sucher mit Filmlook (WebGL2, läuft auf der GPU), Objektive 0,5×/1×/2×/3×
  und Frontkamera, Belichtung per senkrechtem Wischen im Sucher
- Acht Filme: Pastell 400, Aurum 200, Alltag 400, Vivid 100 (Farbnegativ),
  Kino 500T und Kino 250D (Kinofilm), Chrom 50 und Chrom 100 (Dia)
- Physikalisches Modell wie in Filmlab: Schichtübersprechen, Negativdichte,
  Vergrößerer und Fotopapier bzw. Umkehrkurve, Farbstoff-Nebenabsorptionen;
  Korn in der Negativdichte, Halation als rötliches Streulicht der
  Filmrückseite, Lichtlecks als echtes Licht auf dem Film
- Ausführliche Regler: Belichtung, Temperatur, Tönung, Kontrast, Sättigung,
  Lichter, Verblassen, Korn und Korngröße, Halation und Radius, Bloom,
  Vignette, Lichtleck (mit Würfel für neue Varianten)
- Datumsstempel im Stil der Kompaktkameras, Filmrahmen mit Perforation und
  Randbeschriftung, Formate 3:2, 16:9 und 2.39:1, Querformat-Erkennung
- Galerie im Gerät (IndexedDB): Jedes Foto wird mit dem unentwickelten
  Original gespeichert und lässt sich später mit anderem Film oder anderen
  Reglern neu entwickeln; Sichern in die Fotos-App über das Teilen-Menü
- Import aus der Mediathek in voller Qualität (bis ca. 12 MP)

**Grenzen einer Web-App:** Safari liefert nur den Videostream der Kamera
(höchstens ca. 12 MP, automatische Belichtung, kein RAW/ProRAW, kein manueller
Fokus). Für maximale Qualität mit der iPhone-Kamera fotografieren und das Foto
in der Filmkamera importieren.

## So funktioniert die Umwandlung

Statt das Bild einfach zu invertieren, arbeitet Filmlab wie ein Fotolabor im
**Dichteraum**:

1. Der Scan wird in lineares Licht zurückgerechnet und in optische Dichte
   (log10) umgewandelt. Dort ist die orange Maske eines Farbnegativs nur noch
   ein konstanter Versatz pro Kanal, und die unterschiedlichen Gradationen der
   drei Farbschichten sind ein einfacher Faktor.
2. Jede Farbschicht wird anhand robuster Perzentile einzeln kalibriert
   (Korn, Staub und Kompressionsartefakte werden vorher herausgemittelt,
   Filmrand und Perforation ignoriert). Optional definiert die mit der Pipette
   gemessene **Filmbasis** die Farbneutralität der Schatten.
3. Weißabgleich und Belichtung wirken als Verschiebung im Belichtungsraum –
   physikalisch wie ein Farbfilter bzw. eine längere Belichtung im Vergrößerer.
4. Eine Papiergradation bildet die Log-Belichtung auf das Bild ab: Die Lichter
   werden wie bei Fotopapier und Laborscannern im Belichtungsraum weich
   komprimiert und laufen asymptotisch gegen Weiß (einstellbar über
   „Lichter-Rolloff“), sanfte S-Kurve, Schwarz bleibt schwarz.
5. Sättigung und Dynamik laufen farbtonerhaltend und weich gegen die
   Gamut-Grenze, statt hart zu clippen – kräftig, aber nie grell.
6. Eine Auto-Belichtung legt die Mitteltöne neutral, ohne Spitzlichter
   ausfressen zu lassen; Low-Key-Bilder behalten ihren Charakter.

### Analoger Abzug (Standard)

Im Tonmodell „Analoger Abzug“ wird der Weg vom Negativ zum Farbabzug im
Labor nachgebildet:

1. **Negativ:** normierte Dichte jeder Farbschicht (Negativgradation ≈ 0,6).
2. **Vergrößerer:** Das Licht belichtet durch das Negativ das Papier –
   Belichtung entspricht der Belichtungszeit, Weißabgleich den Farbfiltern
   im Filterkopf (Verschiebung der Belichtung je Papierschicht).
3. **RA-4-Fotopapier:** Schwärzungskurve je Schicht mit weichem Fuß gegen
   Papierweiß (Dmin ≈ 0,08), gerader Gradation und Schulter gegen
   Papierschwarz (Dmax ≈ 2,3). „Kontrast“ wählt die Papiergradation,
   „Lichter-Rolloff“ die Weichheit des Fußes.
4. **Papierfarbstoffe:** Cyan, Magenta und Gelb absorbieren auch ungewollt
   in den Nachbarbereichen; das ergibt den typischen Farbcharakter eines
   Abzugs (Regler „Papierfarbstoffe“, Grau bleibt neutral).
5. **Betrachtung:** Reflexion = 10^−Dichte; Papierweiß wird Bildschirmweiß,
   Papierschwarz Bildschirmschwarz.

Das frühere lineare Modell steht als „Digital“ zur Verfügung (Dias nutzen es
automatisch).

Die Standardwerte wurden mit simulierten Farbnegativen (Filmmodell mit oranger
Maske, schichtabhängiger Gradation, Toe und Schulter) gegen die Originalfotos
abgestimmt.

## Funktionen

**Film & Scan**
- Farbnegativ (C-41), S/W-Negativ, Dia/Positiv (E-6)
- Gamma-kodierte oder lineare Scans (z. B. aus RAW entwickelte Linear-TIFFs)
- **Automatische Bildfeld-Erkennung**: Filmhalter, Klammern, Filmrand und
  durchscheinendes Leuchtpult werden beim Import weggeschnitten
- Filmbasis-Pipette (mit Warnung bei übersteuerter Basis), Schwarz-/Weiß-Clipping, Analyse-Rand
- **S/W-Negative werden automatisch erkannt**
- **Im Scan beschnittene Kanäle** (typisch: Rot bei Kamera-Scans) werden erkannt,
  der Schwarzpunkt geschätzt und die beschnittenen Werte aus den intakten
  Kanälen rekonstruiert
- **Automatische Graubalance** an fast neutralen Motivteilen (abschaltbar)
- **Kamera-Scan-Farbkorrektur**: gleicht das Übersprechen der Kamerafilter aus
  (Grün kippt sonst Richtung Cyan, das Bild wirkt kühl); abschaltbar
- Gekoppelte oder kanalweise Analyse, Kanal-Feinabstimmung (Schwarz-/Weißpunkt R/G/B)
- **Analyse sperren** + **Auf alle**: identische Abstimmung für eine ganze Filmrolle

**Bearbeitung**
- Weißabgleich (Pipette, Temperatur, Tönung)
- Belichtung, Kontrast, Lichter-Rolloff, Tonumfang, Lichter, Tiefen, Weiß, Schwarz, Auto-Belichtung
- Dynamik (schont Hauttöne) und Sättigung
- Farbmischer (HSL) für 8 Farbbereiche
- Color Grading für Tiefen, Mitteltöne und Lichter
- Gradationskurven (RGB und einzelne Kanäle)
- Schärfen mit Maskierung, Filmkorn
- Drehen, Spiegeln, Begradigen (mit automatischem Beschnitt), Zuschnitt mit
  Formaten (Kleinbild, 6×4,5, 6×6, 6×7, 4×5″, XPan …)

**Arbeitsablauf**
- Filmstreifen mit mehreren Bildern, Kopieren/Einfügen von Einstellungen
- Look-Presets (mitgeliefert und eigene), u. a. „Laborscan weich“ (Noritsu-Anmutung)
  und „Laborscan kräftig“ (Frontier-Anmutung)
- Unbegrenztes Rückgängig/Wiederholen pro Bild, Einstellungen werden automatisch
  im Browser gespeichert
- Vorher/Nachher, Clipping-Warnung, Histogramm, Pixelwerte, 100 %-Ansicht
- Export als JPEG, PNG oder **16-Bit-TIFF**, in Originalgröße oder verkleinert,
  einzeln oder alle Bilder in einen Ordner; Einstellungen optional als JSON

**Tipps für Kamera-Scans:** Möglichst RAW fotografieren und als 16-Bit-TIFF
entwickeln. So belichten, dass der unbelichtete Filmrand in keinem Kanal
ausfrisst (Histogramm der Kamera prüfen) – sonst gehen Farbinformationen in
den Schatten verloren.

**Formate:** TIFF (8/16/32 Bit; unkomprimiert, LZW, ZIP, PackBits; Strips oder
Kacheln), JPEG, PNG, WebP. Kamera-RAW-Dateien bitte vorher als (lineares)
16-Bit-TIFF entwickeln.

Tastenkürzel und Tipps stehen in der App unter „?“.

## Kommandozeile

Für Stapelverarbeitung ohne Browser (Node.js ≥ 18, nur TIFF-Eingabe):

```bash
node tools/filmlab-cli.mjs scans/*.tif --out positive --format tif
node tools/filmlab-cli.mjs scan.tif --settings rolle.filmlab.json --format png16
```

Optionen: `--format tif|png|png16`, `--settings <json aus der App>`,
`--type color|bw|positive`, `--exposure <EV>`, `--contrast <n>`,
`--no-auto`, `--no-crop`, `--max <px>`, `--out <ordner>`.

## Entwicklung

```bash
node --test tests/*.test.mjs                        # Tests
python3 tools/make_test_negatives.py test-negatives # simulierte Negative erzeugen
                                                    # (numpy, scikit-image, tifffile, imagecodecs)
```

Der Bildverarbeitungskern (`js/core/`) ist frei von DOM-Abhängigkeiten und
läuft identisch im Browser und in Node.js.

Das Beispiel-Negativ ist aus dem NASA-Foto „Astronaut Eileen Collins“
(gemeinfrei, über scikit-image) mit dem Filmmodell simuliert.
