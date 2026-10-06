# Theming

Teahouse styles its interface with CSS variables ("tokens"). Themes as plugins come later
(v0.4); until then a world can override tokens in the frontmatter of its `world.md`:

```yaml
---
id: …
type: world
name: Rain Port
theme:
  vn-textbox-bg: "rgb(10 20 40 / 85%)"
  vn-name-bg: "#3b6ea5"
  vn-font: "Georgia, serif"
---
```

Overrides apply to the visual novel view of that world's chats. Values are plain CSS values.
Anything with `url(`, `;`, braces or angle brackets is ignored, so a shared world cannot load
external resources or inject other styles.

## Tokens

| Token | Default | Used for |
|---|---|---|
| `color-bg` | warm off-white / near black | Page background |
| `color-surface` | white / dark grey | Cards, inputs |
| `color-text` | dark brown / light beige | Body text |
| `color-text-muted` | | Hints, secondary text |
| `color-accent` | brown / amber | Buttons, highlights |
| `font-body` | system UI font | Interface text |
| `font-story` | Georgia | Story text in the log view |
| `vn-stage-bg` | dark brown | Stage behind the background image |
| `vn-textbox-bg` | translucent dark | Text box |
| `vn-textbox-color` | light beige | Text in the text box |
| `vn-textbox-border` | thin light line | Text box border (a full `border` value) |
| `vn-textbox-radius` | `10px` | Corners of text box and name badge |
| `vn-name-bg` | accent | Speaker name badge |
| `vn-name-color` | accent text | Speaker name text |
| `vn-font` | `font-story` | Text box font |
| `vn-font-size` | `1.1rem` | Text box font size |
| `vn-sprite-height` | `78%` | Character image height relative to the stage |
| `vn-sprite-dim` | `0.55` | Opacity of characters who are not speaking |

The `color-*` tokens have light and dark defaults that follow the system setting.
