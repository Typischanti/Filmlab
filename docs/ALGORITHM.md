# Mathematische Grundlagen der Negativumwandlung

Dieses Dokument beschreibt die in FilmLab implementierte Verarbeitung. Jeder
Schritt ist als **[physikalisch]** (aus dem Mess-/Filmmodell hergeleitet) oder
**[heuristisch]** (gestalterische bzw. statistische Annahme) gekennzeichnet.
Die Verweise in Klammern zeigen auf den Quellcode.

---

## 1. Lineare Messwerte  **[physikalisch]**

Alle Bilddaten werden als **lineare Lichtwerte** in float32 im Arbeitsfarbraum
*lineares Rec. 2020 (D65)* verarbeitet (`core/colorspace.py`).

* **RAW** (`imaging/loader.py`): LibRaw über rawpy mit `gamma=(1,1)`,
  `no_auto_bright=True`, `output_bps=16`, Schwarzpunktabzug und
  Sättigungsnormierung durch LibRaw, Highlight-Modus *Clip* (erhält die
  Linearität), Ausgabe direkt in Rec. 2020. Weißabgleich: LibRaw-Tageslicht
  (für die Inversion unerheblich, siehe 3.).
* **TIFF/PNG 16 Bit, JPEG 8 Bit**: Dekodierung der Transferfunktion (sRGB
  oder linear, wählbar) und Matrix-Konvertierung sRGB → Rec. 2020.

Rec. 2020 ist groß genug, dass die stark gesättigten Farben eines Negativs
(Orangemaske) nicht in negative Komponenten fallen, bevor logarithmiert wird.

## 2. Mess- und Filmmodell

Ein Scan misst je Kanal c die durch den Film transmittierte Lichtmenge:

```
S_c = k_c · T_c = k_c · 10^(−D_c)
```

* `T_c` Transmission, `D_c` optische Dichte (Summe der Farbstoffdichten im
  spektralen Empfindlichkeitsbereich des Kanals),
* `k_c` fasst **alle** kanalweisen, ortsunabhängigen Faktoren zusammen:
  Lichtquelle, Sensorempfindlichkeit, Belichtungszeit, Weißabgleich-Multiplikator.

Die Dichte setzt sich zusammen aus

```
D_c = D_min,c + D_bild,c
```

mit `D_min,c` = Träger + Schleier + (bei C-41) farbige **Orangemaske**, und
`D_bild,c` = bildmäßige Farbstoffdichte. Im geraden Teil der
Schwärzungskurve gilt

```
D_bild,c = γ_c · log10(H_c) + C_c
```

`H_c` ist die Belichtung (∝ Szenenleuchtdichte im jeweiligen Kanal),
`γ_c` die Gradation der Farbschicht (bei C-41 typischerweise ≈ 0.5–0.7, je
Schicht verschieden), `C_c` eine Konstante.

## 3. Filmgrund-Kompensation  **[physikalisch]**

Der unbelichtete Filmrand liefert `B_c = k_c · 10^(−D_min,c)`. Daraus folgt
die bildmäßige Dichte

```
D_bild,c = −log10(S_c / B_c)                              (inversion.density)
```

**`k_c` und die Orangemaske kürzen sich exakt heraus.** Das ist der Grund,
warum weder Weißabgleich noch Belichtung *vor* der Inversion „richtig“ sein
müssen: jede kanalweise Konstante (also auch ein Weißabgleich oder eine
andere Lichtquelle) verschwindet in diesem Quotienten. Der Test
`test_result_independent_of_mask_and_light` prüft das für verschiedene
Masken und Lichtquellen.

Numerische Stabilität: die Transmission `S/B` wird nach unten auf
`10^(−4)` begrenzt (max. 4.0 Dichte über Filmgrund, real kommen kaum mehr als
≈ 3 vor). Werte heller als der Filmgrund (Rauschen, Licht an der
Perforation) ergeben kleine *negative* Dichten statt NaN. Der Filmgrundwert
wird nach unten auf 1e−6 begrenzt.

Feinjustierung: die Regler „Maske R/G/B (ΔD)“ addieren eine Dichte zur
Maske, `B'_c = B_c · 10^(−ΔD_c)`. Positives ΔD macht den Kanal im Positiv
dunkler.

## 4. Bestimmung des Filmgrunds  **[heuristisch, mit Plausibilitätsprüfung]**

Automatisch (`imaging/filmbase.py::detect_base`), auf einem Analyse-Proxy
(lange Kante 1200 px, flächengetreu verkleinert):

1. Bild in Blöcke teilen; je Block Mittelwert und relative Streuung.
2. Kandidaten: gleichmäßige (rel. Streuung < 5 %), nicht gesättigte
   (< 98.5 % des Maximums) Blöcke im Randstreifen (12 % je Seite) bzw.
   außerhalb des Zuschnitts.
3. Die helleren Kandidaten werden nach Farbe geclustert (Abstand in log10).
4. **Durchlicht ohne Film** (Perforation, Lücken zwischen Bildern) ist heller
   als der Filmgrund und – bei C-41 – neutral statt orange. Ein heller,
   neutraler Cluster wird zugunsten eines orangefarbenen verworfen bzw. bei
   einem Helligkeitsabstand > 0.12 log10 zugunsten des nächsthelleren.
5. Ein echter Filmrand verläuft **durchgehend** entlang einer Kante
   (≥ 35 % der Kantenlänge). Gleichmäßige dunkle Motivflächen am Rand
   erfüllen das nicht.
6. Der Filmgrund muss heller sein als (fast) der gesamte Bildinhalt
   (≥ 97 % des 99.5-Perzentils je Kanal).

Plausibilitätsprüfungen (`check_base`, auch für manuelle Messbereiche):
Sättigung des Filmgrunds, sehr dunkler Scan (Rauschen), Anteil der Bildpixel
heller als die Referenz, fehlende Orangefärbung bei C-41 (Hinweis auf bereits
maskenkorrigierte Scans), ungleichmäßiger Messbereich. Daraus ergibt sich eine
Konfidenz, die in der Oberfläche angezeigt wird.

**Ersatzschätzung ohne Filmrand** (`estimate_from_content`): 99.8-Perzentil
des leicht geglätteten Bildinhalts ×1.02 (hellste Negativbereiche ≈ tiefste
Szenenschatten ≈ D_min). Wird deutlich als *geschätzt / weniger zuverlässig*
gekennzeichnet; die Normierung schaltet dann auf kanalweise Schwarzpunkte.

Zusätzlich wird der **belichtete Bildbereich** erkannt (`detect_frame`:
Zeilen/Spalten mit ≥ 30 % Pixeln über 0.06 Dichte), damit Filmrand und
Perforation nicht in die Tonwertanalyse eingehen. Er kann als Zuschnitt
übernommen werden.

## 5. Normierung  **[heuristisch – Wahl der Referenzpunkte]**

Aus den Dichten des Bildbereichs (leicht geglättet, um Rauschen in dichten
Bereichen nicht als Spitzlicht zu werten) werden je Kanal bestimmt:

```
d_lo,c = Perzentil(D_bild,c, Schwarz-Clip %)     (Szenenschwarz)
d_hi,c = Perzentil(D_bild,c, 100 − Weiß-Clip %)   (Szenenweiß)
e_c    = (D_bild,c − d_lo,c) / (d_hi,c − d_lo,c)
```

Setzt man das Filmmodell ein, gilt im geraden Kurventeil

```
e_c = log10(H_c / H_schwarz) / log10(H_weiß / H_schwarz)
```

– **unabhängig von γ_c und C_c**, sofern Schwarz- und Weißpunkt der Szene
neutral sind. Die unterschiedlichen Gradationen der Farbschichten werden so
ausgeglichen; neutrale Grautöne bleiben neutral
(`test_gray_scale_stays_neutral_with_different_layer_gammas`).

Zwei Modi:

* **Kanalweise** (Standard): `d_lo` je Kanal aus dem Bild. Exakt für das
  lineare Filmmodell, benötigt neutrale Tiefen *und* Lichter im Motiv.
* **Filmgrund-referenziert**: gemeinsamer Schwarzpunkt `d_lo = min_c d_lo,c`
  für alle Kanäle; die Farbbalance der Schatten kommt damit allein aus der
  Maskenmessung (unbelichteter Film = neutrales Schwarz). Sinnvoll für Motive
  ohne neutrales Schwarz; Schleier-/Fußunterschiede der Schichten können zu
  leichten Schattenstichen führen.

Für einen ganzen **Filmstreifen** (`batch.roll_analysis`) behält jedes Bild
seinen eigenen, zuverlässig gemessenen Filmgrund – so kürzen sich auch
wechselnde Scanbedingungen (Kamera-Belichtungs- oder Weißabgleichsautomatik)
je Bild heraus; Bilder ohne Rand erhalten den Median der übrigen. Die
Schwarz-/Weißpunkte als Dichten *relativ zum Filmgrund* spiegeln die für den
ganzen Film identische Entwicklung wider und werden gemeinsam bestimmt
(Median je Kanal) und gesperrt. Farbwiedergabe ist damit konsistent,
Belichtungsunterschiede zwischen den Aufnahmen auf dem Film bleiben erhalten
(`test_roll_analysis_robust_to_varying_scan_conditions`).

## 6. Umrechnung in szenenlineares Licht  **[physikalisch + heuristischer Schwarzpunkt]**

Der logarithmische Motivumfang folgt aus der Dichtespanne und der
Filmgradation:

```
R = mean_c(d_hi,c − d_lo,c) / γ_film        (begrenzt auf 1.0 … 3.6)
L_c = 10^(R · (e_c − 1))                    Weiß → 1, Schwarz → 10^(−R)
```

`γ_film` ist der Regler „Filmgradation“ (Profile: 0.60). Für das lineare
Filmmodell mit `γ_film = mean(γ_c)` ist `L_c` exakt proportional zur
Szenenbelichtung (`test_exact_inversion_of_linear_film_model`).

Danach wird der Restschwarzwert abgezogen **[heuristisch]**, vergleichbar
mit einer Streulicht-/Papierschwarz-Korrektur:

```
L'_c = (L_c − 10^(−R)) / (1 − 10^(−R))
```

Optional **[heuristisch]** „Auto-Balance“: ein Exponent je Kanal
`e_c' = e_c^g_c`, der die Mediane der Mitteltöne angleicht (Grauwelt-Annahme,
Endpunkte fest). Standardmäßig aus.

**Diafilm**: keine Inversion; `L = (S − lo)/(hi − lo)` mit gemeinsamen
(luminanzbasierten) Perzentilen, damit die Farbbalance des Dias erhalten bleibt.
**S/W-Negativ**: ein Kanal aus gewichteter Mischung (Standard: Rec.-2020-Luminanz),
sonst identisch.

## 7. Bildgestaltung  **[heuristisch]**

Reihenfolge in `pipeline.finish`:

1. **Belichtung, Weißabgleich** – linear als Faktoren auf L (physikalisch
   sinnvoll, da Lichtmengen). Temperatur/Tint sind relative Verschiebungen
   (±0.5 EV zwischen den Kanälen), keine Kelvin-Angaben, da die
   Aufnahmelichtart eines Negativs unbekannt ist; die Luminanz bleibt
   erhalten. Neutralpunkt-Pipette: Faktoren = 1/Messwert, normiert auf Grün.
2. **Tonwerte** im wahrnehmungsnahen Bereich `q = L^(1/2.2)`, kombiniert zu
   einer monotonen Float-LUT:
   Lichterschulter (Reinhard-artig, C¹-stetig, bildet einen Punkt w > 1 auf
   1 ab – weiche Kompression statt hartem Clipping), Schwarz-/Weißpunkt,
   Gamma, Helligkeit, Tiefen/Lichter (polynomiale Gewichte, Endpunkte fest),
   Kontrast (konvexe Mischung mit einer S-Kurve um Mittelgrau), Gradations-
   kurven (monotone kubische Hermite-Interpolation nach Fritsch–Carlson).
   Monotonie wird erzwungen → keine Tonwertumkehr.
3. **Rauschreduzierung**: Chroma-Weichzeichnung, bilaterale Luminanzfilterung.
4. **Schärfung**: Unscharfmaskierung auf der Luminanz.
5. **Sättigung/Dynamik**: luminanzerhaltend; Dynamik wirkt stärker auf
   wenig gesättigte Farben.

Räumliche Radien sind auf die volle Auflösung bezogen und werden mit dem
Maßstab skaliert, damit die verkleinerte Vorschau dem verkleinerten Export
entspricht (`test_preview_matches_export`).

## 8. Ausgabe  **[physikalisch / normiert]**

`q → L = q^2.2` → Matrix Rec. 2020 → Zielraum (Bradford-Adaption für
ProPhoto/D50) → **Gamut-Kompression**: Pixel mit negativen Komponenten werden
luminanzerhaltend genau so weit entsättigt, dass die kleinste Komponente 0
wird → Transferfunktion (sRGB, Adobe-RGB-kompatibel γ=563/256, ROMM,
BT.2020 oder linear) → Quantisierung erst ganz am Ende (16 Bit; bei 8 Bit
mit deterministischem TPDF-Dithering gegen Banding).

ICC-Profile (v2, Matrix/TRC, Kolorante nach D50 adaptiert) werden selbst
erzeugt (`core/icc.py`) und in TIFF/JPEG/PNG eingebettet. Die Tests prüfen,
dass LittleCMS mit diesen Profilen dieselbe Transformation liefert wie die
interne Matrix-Pipeline (Abweichung < 1.5/255).

## 9. Schneller Pfad und Konsistenz

Für interaktive Geschwindigkeit werden die Transferfunktionen als Float-LUTs
über `√L` statt `q` indiziert (dort nahezu linear → genaue Interpolation),
Belichtung/Weißabgleich als Skalierung des LUT-Index angewendet
(`√(g·L) = √g·√L`), und LUTs per `cv2.remap` in einem Durchgang auf alle
Kanäle angewendet. `finish_reference` ist die direkte Implementierung mit
`pow()`; der Test `test_fast_path_matches_reference` stellt eine Abweichung
< 2e−6 in linearem Licht sicher. Vorschau und Export benutzen **denselben**
Pfad und **dieselben gespeicherten Analysewerte**.

## 10. Bekannte Modellgrenzen

* Das Filmmodell ist im geraden Kurventeil exakt; Fuß und Schulter realer
  Filme sowie Interimage-Effekte (Farbkopplung zwischen Schichten) werden
  nicht modelliert. Die Farbtrennung hängt von der spektralen Überlappung
  von Lichtquelle, Sensor und Farbstoffen ab: Kamera-Scans mit Weißlicht
  liefern mehr Übersprechen als schmalbandige RGB-Beleuchtung.
* Die Filmprofile enthalten **keine gemessenen Kennlinien**, sondern
  dokumentierte Ausgangswerte (siehe `basis` in den JSON-Dateien).
