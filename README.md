# Filmkamera

Kamera-App fürs iPhone mit spektraler Filmemulation – als Web-App für den
Home-Bildschirm (kein Mac und kein App Store nötig). Alles läuft lokal auf
dem Gerät, Fotos und Videos verlassen das iPhone nur, wenn du sie teilst.

**Adresse:** https://typischanti.github.io/Filmlab/camera/

**Installieren:** Die Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“.
Danach startet sie im Vollbild wie eine normale App und funktioniert auch
offline. Kamera, Mikrofon und Lagesensor fragt sie bei Bedarf ab.

## Funktionen

- Live-Sucher mit Filmlook (WebGL2, läuft auf der GPU), Objektive 0,5×/1×/2×/3×
  und Frontkamera, Belichtung per senkrechtem Wischen im Sucher
- 16 Filme: Portra 160/400/800, Ektar 100, Gold 200, Ultramax 400, Pro 400H,
  C200 (Farbnegativ), Vision3 250D/500T (Kino), Velvia 100, Provia 100F,
  Ektachrome 100, Kodachrome 64 (Dia) – spektral berechnet, siehe unten –
  sowie Straße 400 und Silber 100 (Schwarzweiß, analytisches Modell)
- Korn in der Negativdichte, Halation als rötliches Streulicht der
  Filmrückseite, Lichtlecks als echtes Licht auf dem Film, Belichtungsumfang
  je Film (Rekonstruktion der vom iPhone gestauchten Lichter)
- Ausführliche Regler: Belichtung, Temperatur, Tönung, Kontrast, Sättigung,
  Lichter, Verblassen, Korn und Korngröße, Halation und Radius, Bloom,
  Vignette, Lichtleck (mit Würfel für neue Varianten)
- Datumsstempel im Stil der Kompaktkameras; Rahmen: Filmstreifen mit
  Perforation und Randbeschriftung, Laborabzug, Sofortbild – schon im Sucher
  sichtbar; Formate 3:2, 16:9 und 2.39:1, Querformat-Erkennung
- **Video:** aufgenommen wird der fertig entwickelte Sucher mit Film-Look,
  bewegtem Korn, Halation, Rahmen und Datumsstempel, dazu der Ton (MP4 auf
  dem iPhone, bis 3 Minuten je Clip, Auflösung des Suchers)
- Galerie im Gerät (IndexedDB): Jedes Foto wird mit dem unentwickelten
  Original gespeichert und lässt sich später mit anderem Film oder anderen
  Reglern neu entwickeln; Sichern in die Fotos-App über das Teilen-Menü
- Import aus der Mediathek in voller Qualität (bis ca. 12 MP)
- Filmrolle mit 36 Aufnahmen (optional mit „Entwicklung“ am Ende), eigene
  Looks, Selbstauslöser 3/10 s

## Spektrale Filme

Die 14 Farbfilme werden spektral berechnet: Szenenspektrum → gemessene
Schichtempfindlichkeiten → Kennlinien (mit einfachem DIR-Kupplermodell) →
Farbstoffspektren → Fotopapier bzw. Kinokopierfilm → Normbeobachter. Jeder
Film wird auf dem zu ihm passenden Papier abgezogen (Portra Endura, Supra
Endura, Ultra Endura, Ektacolor Edge, Crystal Archive, Kodak 2383).

Die Messdaten stammen aus [spektrafilm](https://github.com/andreavolpato/spektrafilm)
von Andrea Volpato (CC BY-SA 4.0). Die Berechnung ist eine eigene Umsetzung in
`tools/spectral/` und wird vorab in 3D-LUTs (`camera/luts/`, ebenfalls
CC BY-SA 4.0, siehe `LICENSE.txt` und `CHANGELOG.txt` dort) gerechnet:

```bash
node tools/spectral/bake-luts.mjs --profiles <spektrafilm>/src/spektrafilm/data/profiles
```

## Grenzen einer Web-App

Safari liefert nur den Videostream der Kamera (höchstens ca. 12 MP,
automatische Belichtung, kein RAW/ProRAW, kein manueller Fokus). Für maximale
Qualität mit der iPhone-Kamera fotografieren und das Foto in der Filmkamera
importieren.

## Entwicklung

```bash
npm start      # lokaler Webserver, dann http://localhost:8000/camera/ öffnen
npm test       # Tests des Filmmodells (Node.js ≥ 18)
```

Aufbau von `camera/`:

| Datei | Inhalt |
|---|---|
| `js/model.js` | Filmmodell (ohne DOM, auch in Node.js lauffähig) |
| `js/gl.js` | WebGL2-Renderer, rechnet dasselbe Modell auf der GPU |
| `js/films.js` | Filmliste |
| `js/develop.js` | Entwickeln in voller Auflösung, Rahmen, Datumsstempel |
| `js/camera.js`, `js/recorder.js` | Kamera, Objektive, Lage, Videoaufnahme |
| `js/store.js`, `js/lut.js` | Galerie (IndexedDB), Laden der LUTs |
| `js/main.js` | Oberfläche |

Veröffentlicht wird über GitHub Pages (`.github/workflows/pages.yml`), sobald
etwas auf `main` landet.
