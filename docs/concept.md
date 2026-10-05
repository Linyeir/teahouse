# Teahouse – Konzept v1

Teahouse ist eine selbsthostbare Open-Source-Software für KI-Rollenspiel im Stil einer Visual Novel. Sie besteht aus einem Server und Clients für Web, Desktop und Android. Vorbild ist SillyTavern, Teahouse ist aber ein eigenständiges Projekt ohne gemeinsamen Code.

Dieses Dokument hält die getroffenen Konzeptentscheidungen fest. Es ist die Grundlage für Architektur und Implementierung.

## Änderungen gegenüber v0

- **Regie-Pipeline gestrichen.** Ein Zug ist ein einziger Generierungsaufruf, der Erzählung, Dialog, Gesichtsausdrücke und Hintergrundwechsel als Tag-Markup liefert.
- **Abgeschlossene Szenen sind unveränderlich.** Keine Forks, Swipes oder Edits in abgeschlossenen Szenen. Forks gibt es nur innerhalb der aktiven Szene.
- **Canon entsteht beim Schließen der Szene**, nicht über eine Warteschlange. Die nächste Szene beginnt erst danach.
- **Canon-Budget** mit Kurzzusammenfassungen im Frontmatter.
- **Parallele Chats in einer Welt** werden nicht gegeneinander abgesichert. Widersprüche verantwortet der Nutzer.
- Technische Präzisierungen aus dem Review: Memory-Auslöser mit Hysterese, strukturierte Canon-Änderungen, Git-Warteschlange, sync-fähiges Schema von Anfang an.

## 1. Alleinstellungsmerkmale

1. **Zweistufiges Memory.** Active Memory hält lange Szenen im Kontextfenster, ein Canon bildet das dauerhafte Weltwissen als Git-versionierte Markdown-Dateien.
2. **Getrennte Darstellung von Erzählung und Dialog** in einer Visual-Novel-artigen Ansicht mit Charakterbildern und Hintergründen.
3. **Szenen als Einheit.** Der Nutzer schließt Szenen ab, daraus entsteht Canon. Abgeschlossenes bleibt abgeschlossen.
4. **Sync zwischen Geräten** über einen eigenen Server, mit Offline-Nutzung der Apps.

## 2. Rahmenbedingungen

| Thema | Entscheidung |
|---|---|
| Lizenz | AGPL-3.0 für Teahouse und eigene Plugins. Für Drittplugins erwartet, nicht erzwungen. |
| Zielgruppe | Technikaffine Self-Hoster |
| Nutzer | Ein Nutzer pro Instanz |
| Plattformen | Web, Desktop (Windows, macOS, Linux), Android als APK ohne Store. Kein iOS. |
| Generierung | Ausschließlich über externe APIs, nur Chat Completion |
| Kompatibilität | LM Studio, llama.cpp (`llama-server`), OpenRouter, allgemein OpenAI-kompatible Endpunkte |
| Sprache | i18n von Anfang an, Englisch und Deutsch. Standard-Prompts auf Englisch mit Template-Variable für die Ausgabesprache. |
| Feature-Parität zu ST | Ausdrücklich nicht angestrebt |

## 3. Technischer Stack

- **Server:** TypeScript auf Node.js, Fastify für REST-API und WebSocket (Streaming, Sync-Benachrichtigungen). Das Hook-Modell von Fastify passt zum späteren Plugin-System.
- **Datenbank:** SQLite mit Drizzle ORM (Chats, Szenen, Nachrichtenbaum, Active Memory, Einstellungen, Profile)
- **Weltdaten:** Markdown-Dateien im Dateisystem, versioniert mit dem `git`-Binary über `simple-git`
- **Client:** React-Web-App, verpackt mit Tauri 2 für Desktop und Android
- **Repository:** pnpm-Monorepo

```
packages/
  server/       API, Prompt-Bau, Git, File-Watcher, Plugins
  client/       React-App (Web, Tauri)
  shared/       gemeinsame Typen, Tag-Parser, Sync-Protokoll
  plugin-sdk/   Typen und Hilfen für Plugin-Autoren (später)
```

- **Betrieb:** Docker-Image mit Git, Daten-Volume für SQLite, Welten und Assets
- **Zugang:** Passwort beim ersten Login, danach ein widerrufbares Token pro Gerät, Kopplung per QR-Code. HTTPS übernimmt der Reverse-Proxy oder Tailscale des Nutzers.

### Schema-Regeln ab Tag 1

Sync kommt später, das Schema muss ihn aber jetzt schon tragen:

- Alle IDs sind client-erzeugbare UUIDv7
- Jede synchronisierte Zeile hat `updated_at` und einen Revisionszähler
- Löschen ist ein Soft-Delete (Tombstone)

## 4. Domänenmodell

- **Welt:** Ein Ordner mit Canon-Dateien, Assets und einem Git-Repository. Jede Figur gehört zu einer Welt.
- **Figur:** Eine Datei in `characters/` plus Charakterbilder mit freien Labels (z. B. `neutral`, `amused`).
- **Chat:** Gehört zu genau einer Welt. Ist eine lineare Folge von Szenen.
- **Szene:** Hat eine Startnachricht, eine Besetzung und einen Status:
  - `aktiv` – Nachrichten bilden einen Baum (Forks, Swipes, Edits)
  - `wird abgeschlossen` – Canon-Vorschlag wird erzeugt und geprüft
  - `abgeschlossen` – der gewählte Pfad ist eingefroren, alle anderen Äste werden verworfen
- **Nachricht:** Knoten im Baum der aktiven Szene. Eine KI-Nachricht besteht aus mehreren Beats.
- **Beat:** Ein Abschnitt einer Nachricht, entweder Erzählung oder Dialog einer Figur mit Gesichtsausdruck, oder ein Hintergrundwechsel.
- **Active-Memory-Knoten:** Zusammenfassung, die an der Nachricht hängt, bis zu der sie zusammenfasst.
- **Profil:** Benannte Kombination aus Endpunkt, Modell und Parametern, die Rollen zugewiesen wird.

Pro Chat ist immer höchstens eine Szene aktiv. Mehrere Chats in derselben Welt sind erlaubt und teilen sich den Canon ohne Absicherung.

### Ordnerstruktur einer Welt

```
welt-name/
  .git/
  .gitignore        enthält assets/ und .obsidian/
  world.md          Grundregeln, Ton, Setting
  user.md           Wissen über die Persona des Nutzers
  characters/       eine Datei pro Figur, inklusive Beziehungen
  places/
  events/           Chronik, eine Datei pro abgeschlossener Szene
  lore/             aus Lorebooks importierte Einträge
  assets/           Charakterbilder, Hintergründe (nicht in Git)
```

### Frontmatter

Jede Markdown-Datei hat YAML-Frontmatter:

| Feld | Pflicht | Zweck |
|---|---|---|
| `type` | ja | `world`, `user`, `character`, `place`, `event`, `lore` |
| `tags` | ja | Schlagwörter für die Kontextauswahl |
| `aliases` | ja | Alternative Namen, ebenfalls für die Kontextauswahl |
| `summary` | ja | Kurzfassung in 1–3 Sätzen, wird bei knappem Budget statt des Volltexts verwendet |
| `images` | nein | Stabile Bild-IDs mit Labels (Figuren, Orte) |
| `chat`, `scene`, `order` | bei `event` | Herkunft und Reihenfolge in der Chronik |

Verknüpfungen laufen über Wikilinks (`[[mira]]`), damit der Ordner auch in Obsidian funktioniert.

## 5. Prompt-System

### Rollen

Jede Rolle hat ein eigenes Prompt-Template und ein zuweisbares Profil. Standard ist ein Profil für alles.

1. **Erzähler** – erzeugt den gesamten Zug: Erzählung, Dialog aller Figuren, Gesichtsausdrücke, Hintergrundwechsel
2. **Szenen-Start** – schlägt Startnachricht und Besetzung einer neuen Szene vor
3. **Active-Memory-Zusammenfassung**
4. **Canon-Aktualisierung**

### Templates

- Template-Sprache mit Platzhaltern wie `{{char}}`, `{{user}}`, `{{memory}}`, `{{scene}}`
- Schichten: global, Welt, Figur, Chat. Spätere Schichten überschreiben frühere.
- `{{user}}` ist überall der Name der Nutzer-Persona.
- `{{char}}` ist ST-kompatibel und bezeichnet innerhalb einer Figurendatei bzw. eines Figuren-Templates die jeweilige Figur. In Rollen-Templates ohne Figurenbezug ist `{{char}}` leer und erzeugt eine Warnung im Template-Editor.
- Kein Import von ST-Presets in v0.1

### Kontextauswahl und Budget

Der Prompt wird in fester Reihenfolge gebaut, Statisches zuerst, damit lokale Server den KV-Cache wiederverwenden können:

1. Rollen-Template (global → Welt → Chat)
2. Canon
3. Figurenliste der Welt (Name, `summary`, verfügbare Labels) und Hintergrundliste mit Kurzbeschreibung
4. Active Memory der Szene
5. Startnachricht der Szene
6. Verlauf der Szene

Der Canon hat ein eigenes Budget (Anteil am Kontextfenster, pro Welt einstellbar). Gefüllt wird nach Priorität:

1. `world.md`, `user.md`, Dateien aller anwesenden Figuren
2. Die letzten zwei `events/`-Dateien dieses Chats
3. Über Schlagwörter und Aliase im Frontmatter: weitere Dateien
4. Ältere `events/`-Dateien

Reicht das Budget nicht, wird von unten nach oben auf `summary` heruntergestuft, danach weggelassen. Stufe 1 wird zuletzt heruntergestuft und nie weggelassen.

Optional später: Embedding-Suche für große Welten.

Es gibt keine Wissenstrennung zwischen Figuren.

### Token-Zählung

- Wo der Endpunkt tokenisieren kann (llama.cpp `/tokenize`), wird gezählt.
- Sonst wird geschätzt, mit einer pro Profil einstellbaren Sicherheitsmarge.
- Das Kontextfenster wird pro Profil automatisch ausgelesen (OpenRouter-Metadaten, llama.cpp `/props`, LM Studio Modellinfo) und ist überschreibbar. Maßgeblich ist der geladene Kontext, nicht das Maximum des Modells.

## 6. Ablauf eines Zugs

1. Der Nutzer schreibt eine Eingabe. `*Sternchen*` markieren Handlung, der Rest ist Rede. Ein Normalisierer übersetzt das in Tags, danach läuft die Eingabe durch denselben Parser wie KI-Antworten.
2. **Ein Erzähler-Aufruf** erzeugt den gesamten Zug und wird gestreamt. Das Modell entscheidet selbst, welche Figuren handeln und sprechen. Nicht jede Figur muss in jedem Zug vorkommen.
3. Die Ausgabe nutzt ein Tag-Markup, das beim Streamen sofort geparst wird:

```
<bg id="taverne-nacht"/>
<narration>Der Regen trommelt gegen die Scheiben. Mira sieht von ihrem Glas auf.</narration>
<say who="mira" mood="amused">Du bist ja doch gekommen.</say>
<leave who="tomas"/>
```

| Tag | Bedeutung |
|---|---|
| `<narration>` | Erzähltext |
| `<say who mood>` | Rede einer Figur. `mood` ist ein Label aus ihrer Bildliste. |
| `<bg id/>` | Hintergrundwechsel, `id` aus der Hintergrundliste der Welt |
| `<leave who/>` | Figur verlässt die Szene, ihr Bild verschwindet |

Eine Figur betritt die Szene implizit mit ihrem ersten `<say>`.

### Robustheit des Parsers

- Text außerhalb von Tags wird als Erzählung behandelt
- Nicht geschlossene Tags werden am Ende des Streams geschlossen
- Unbekanntes `who` wird als Erzählung mit Sprechername angezeigt und markiert
- Unbekanntes `mood` oder `bg` fällt auf das Standardbild bzw. den aktuellen Hintergrund zurück
- Der Erzähler-Prompt verbietet, für `{{user}}` zu sprechen. Zusätzlich bricht der Parser ab, sobald `<say who="{{user}}">` erscheint.

### Swipes und Edits

Nur innerhalb der aktiven Szene:

- **Swipe:** Die ganze KI-Nachricht wird neu erzeugt
- **Edits:** Jede Nachricht der aktiven Szene ist editierbar, auch die des Nutzers und die Startnachricht
- **Forks:** An jeder Nachricht der aktiven Szene möglich

Swipe eines einzelnen Beats (Neugenerierung ab einem Beat per Assistant-Prefill) ist auf später verschoben, weil nicht alle Endpunkte Prefill unterstützen.

## 7. Szenen

- Ein Chat ist eine Folge von Szenen.
- **Nur der Nutzer beendet eine Szene**, per Knopf.
- Beim Beenden wählt der Nutzer den Pfad, falls die Szene Forks hat. Alle anderen Äste werden verworfen.
- **Startnachricht und Besetzung** einer neuen Szene schlägt die Rolle Szenen-Start vor, auf Basis einer kurzen Vorgabe des Nutzers. Der Nutzer kann beides editieren. Beim ersten Chat mit einer importierten Karte dient deren `first_mes` als Startnachricht, `alternate_greetings` werden als Alternativen angeboten.
- Eine neue Szene sieht den Canon und ihre Startnachricht. Über die Event-Priorität (Abschnitt 5) ist die vorige Szene garantiert im Kontext.

## 8. Memory

### Stufe 1: Active Memory

- Kurzzusammenfassung der laufenden Szene, die in den Prompt kommt
- Gespeichert als Knoten im Nachrichtenbaum in SQLite, nicht als Datei und nicht in Git
- Forks und Swipes erben automatisch nur Zusammenfassungen, die vor ihrem Abzweig liegen
- **Auslöser:** Nach einem Zug im Hintergrund, wenn der Verlauf 80 % des Restbudgets erreicht. Restbudget = Kontextfenster − reservierte Antwortlänge − Template − Canon.
- **Ziel:** Es wird so viel zusammengefasst, dass der Verlauf danach bei etwa 50 % liegt. So löst die Zusammenfassung nicht bei jedem Zug aus.
- **Notfall:** Ist die Zusammenfassung beim nächsten Zug noch nicht fertig und das Budget voll, wird synchron gewartet.
- **Inkrementell:** Der Aufruf bekommt die bisherige Zusammenfassung und den Abschnitt, der neu herausfällt, nie den ganzen Verlauf
- **Immer wörtlich im Kontext:** Startnachricht der Szene und die letzten drei Züge. Passen diese allein nicht ins Budget, werden die ältesten der drei Züge gekürzt.
- **Edits:** Wird eine Nachricht editiert, die vor einem Zusammenfassungsknoten liegt, wird dieser als veraltet markiert und im Hintergrund neu berechnet.

### Stufe 2: Canon

- Markdown-Dateien der Welt, Quelle der Wahrheit ist das Dateisystem
- Ein einziger Git-Branch `main` pro Welt
- **Entsteht beim Schließen einer Szene.** Ein LLM schlägt Änderungen vor, mindestens eine neue `events/`-Datei mit `summary`.
- **Format der Vorschläge:** strukturierte Operationen statt freiem Text, damit das LLM keine Inhalte still verliert:
  - `create(path, frontmatter, body)`
  - `append_section(path, heading, text)`
  - `replace_section(path, heading, text)`
  - `set_summary(path, text)`
  - `add_alias(path, alias)` / `add_tag(path, tag)`

  Das Frontmatter verwaltet der Code. Die Diff-Ansicht wird aus dem Ergebnis der Operationen erzeugt.
- **Bestätigung als Diff pro Datei:** annehmen, bearbeiten, verwerfen. Abschaltbar, dann werden Vorschläge automatisch übernommen.
- Nach Bestätigung ein Commit, dessen Nachricht auf Chat und Szene verweist. Erst dann ist die Szene abgeschlossen und die nächste kann beginnen.
- Wird der Canon vor der Bestätigung von außen geändert (Editor, File-Watcher), wird der Vorschlag per 3-Wege-Merge gegen den Basis-Commit abgeglichen. Konflikte zeigt die Diff-Ansicht.
- **Nachträgliche Pflege:** Der Nutzer kann den Canon jederzeit von Hand bearbeiten. Entstehen dadurch Lücken in der Kontinuität, ist das seine Entscheidung.
- **Bearbeitung:** In den Apps über einen Markdown-Editor gegen die Server-API (nur online). Jede Speicherung ist ein Commit. Direkte Änderungen im Dateisystem erkennt ein File-Watcher und committet sie ebenfalls (entprellt, temporäre Editor-Dateien ignoriert).
- **Git-Warteschlange:** Alle Git-Operationen einer Welt laufen seriell über eine Warteschlange, damit sich API, Watcher und Canon-Commits nicht blockieren.
- Git liefert Verlauf, Diff-Ansicht und Rückgängig. Ein späteres Feature „Welt forken“ darf Branches nutzen.

## 9. Sync und Offline

- Der Server ist maßgeblich. Clients halten eine lokale Kopie.
- Synchronisiert werden **nur Chats und Active Memory**, keine Canon-Dateien
- **Offline möglich:** Chats lesen, eine Nachricht vorschreiben (wird beim Wiederverbinden abgeschickt und generiert), Nachrichten der aktiven Szene editieren
- **Konflikte:** Neue Nachrichten von mehreren Geräten werden zu Forks im Baum, nichts geht verloren. Bei Edits derselben Nachricht gewinnt die letzte Änderung, mit Warnung. Keine CRDTs.
- Generierung ist offline nicht möglich, weil Schlüssel und Prompt-Bau auf dem Server liegen

## 10. Darstellung

- Visual-Novel-artige Ansicht mit Ebenen für Hintergrund, Charakterbilder und Text
- Sprecherzuordnung, Charakterbilder mit Gesichtsausdrücken aus `mood`, Hintergrundwechsel aus `<bg>`
- **Keine Musik, keine Animation**
- Freie Labels pro Figur und Welt, beim Hochladen wird ein Standard-Satz vorgeschlagen. Der Erzähler bekommt die Labelliste pro Figur und die Hintergrundliste der Welt mit Kurzbeschreibung.
- Fehlt ein passendes Bild, wird ein Standardbild verwendet
- Bilder werden hochgeladen oder importiert (ST-Karten, Sprite-Pakete). Bildgenerierung gibt es nur als Plugin.
- Später denkbar: ein zusätzlicher Aufruf, der Posen oder Bildwahl aus der Handlung ableitet, wenn `mood` allein nicht reicht

### Themes

- Die App definiert ab v0.1 eine Token-Schicht aus CSS-Variablen (Farben, Typografie, Textbox-Stil der VN-Ansicht)
- Themes sind Plugins, die diese Variablen und optional Schriften und Layout-Varianten liefern (später)
- Ein Theme kann pro Welt voreingestellt werden

## 11. Plugins (später)

- **Voller Zugriff** auf Server und UI. Kein Sandboxing, keine Rechte-Deklaration.
- Serverseitige Plugins laufen im Server-Prozess und hängen sich an Hooks (Prompt-Bau, Provider, Memory-Schritte, Importformate)
- Clientseitige Plugins sind normaler Code in der React-App
- Ein Plugin-Paket enthält optional einen Server-Teil und einen Client-Teil
- **Installation** über Git-URL oder Zip im Server-UI. Der Server lädt seinen Teil und liefert das Client-Bundle an alle Apps, die es beim Start nachladen.
- **Sicherheitsmodell, ausdrücklich:** Ein installiertes Plugin hat Zugriff auf API-Schlüssel und läuft in jeder verbundenen App, in Tauri inklusive der freigegebenen IPC-Befehle. Der Nutzer installiert nur, was er auch selbst ausführen würde.
- **Versioniertes Plugin-API-Feld**, damit alte Plugins nach Updates nicht still kaputtgehen

## 12. Import und Export

### Character Card V2 und V3

Beim Import fragt Teahouse, ob die Figur in eine bestehende oder eine neue Welt kommt.

| Kartenfeld | Ziel in Teahouse |
|---|---|
| `name` | Dateiname und Titel in `characters/` |
| `description`, `personality` | Body der Figurendatei |
| `scenario` | Abschnitt in `world.md` (bei neuer Welt) oder Hinweis in der Figurendatei |
| `first_mes` | Startnachricht der ersten Szene |
| `alternate_greetings` | Alternative Startnachrichten |
| `mes_example` | Abschnitt „Beispieldialog“ in der Figurendatei |
| `system_prompt`, `post_history_instructions` | Figuren-Template-Schicht |
| `creator_notes` | Nicht im Prompt, nur in der UI sichtbar |
| `tags` | `tags` im Frontmatter |
| Eingebettetes Lorebook | Eine Datei pro Eintrag in `lore/`, `keys` werden zu `tags`/`aliases`. Der Nutzer kann Einträge danach nach `characters/` oder `places/` verschieben. |

Nicht übernommen werden Lorebook-Logik wie sekundäre Schlüssel, `selective`, `constant`, Tiefe, Reihenfolge und Rekursion. Karten, die mehrere Figuren oder ein ganzes Szenario beschreiben, werden als eine Datei importiert. Das Aufteilen übernimmt der Nutzer.

### Weiteres

- **ST-Chatverläufe:** Import als eine abgeschlossene Szene, optional mit Canon-Vorschlag
- **Welt-Export:** Archiv aus Git-Repository, Assets und zugehörigen Chats. Das ist zugleich das Austauschformat zum Teilen von Welten.
- **Server-Backup:** Sichern des Daten-Volumes

## 13. Umfang v0.1

- OpenAI-kompatibler Adapter mit Profilen
- Welten als Markdown plus Git
- Import von Character Cards (V2, V3)
- Promptanpassung über Template-Schichten
- Szenen mit Active Memory und Canon inklusive Diff-Bestätigung
- Tag-Markup mit getrennter Darstellung von Erzählung und Dialog, Charakterbilder und Hintergründe
- Web-Client

**Später:** Sync mit Android- und Desktop-Apps, Plugins und Themes, Beat-Swipes, Embeddings, Welt forken, Text Completion, ST-Preset-Import, ST-Chatimport.

### Reihenfolge

1. Server-Grundgerüst, Profile, OpenAI-kompatibler Adapter, schlichter Chat mit einer Figur
2. Welten als Markdown plus Git, Kartenimport
3. Szenen, Active Memory, Canon-Vorschlag mit Diff-Bestätigung
4. **Memory-Testlauf:** einige Referenz-Chats mit Faktenfragen („Wie heißt Miras Bruder?“), die nach Zusammenfassung und Canon-Update automatisch geprüft werden. Grundlage für jedes spätere Tuning der Prompts.
5. Tag-Markup, Parser, getrennte Darstellung
6. Visual-Novel-Ansicht mit Bildern und Hintergründen
7. Welt-Export

Nach Schritt 4 ist das Kernversprechen testbar und kann früh veröffentlicht werden.

## 14. Offene Fragen

- Soll eine Szene sich ohne Canon schließen lassen (z. B. für Nebenszenen ohne Bedeutung)?
- Werden beim Schließen verworfene Äste wirklich gelöscht oder nur ausgeblendet aufbewahrt?
- Standardwert für das Canon-Budget (Vorschlag: 30 % des Kontextfensters)

## 15. Bekannte Nachbarprojekte

- **SillyTavern:** Vorbild. Eine Umsetzung als ST-Erweiterung wurde verworfen, weil Szenenmodell und Sync gegen die ST-Architektur arbeiten würden.
- **Marinara Engine:** Eigenständige TypeScript-Codebasis (AGPL-3.0) mit Sprites, Hintergründen und KI-Agenten. Apps sind PWA bzw. WebView-Hüllen, kein Sync mit entferntem Server. Referenz für die Sprite-Umsetzung.
- **Basic Memory:** Markdown-Dateien als Gedächtnis für LLMs mit SQLite-Index (AGPL-3.0). Referenz für Dateiformat und Indexierung.
- **ST-Erweiterungen Memory Books, Qvink MessageSummarize:** Referenzen für szenenbasierte Erinnerungen und Zusammenfassungen.
