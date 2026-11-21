# Theming

Teahouse styles its interface with CSS variables ("tokens"). You pick a theme and light or dark
under **Settings → Appearance**. The choice is saved on each device.

## Themes

| Theme | Modes | Look |
|---|---|---|
| Standard | light, dark | Warm paper and tea brown |
| Nord | light, dark | The cool blue-grey [Nord](https://www.nordtheme.com) palette |
| Catppuccin | light (Latte), dark (Mocha) | The pastel [Catppuccin](https://catppuccin.com) palette |
| Sakura | light | Soft pink, frosted glass, cherry blossoms |
| Halftone | light | A 90s comic: inked panels, hard shadows, a dot screen |
| Picture book | light | Watercolor paper, a ruled text box, tape for the name |
| Dracula | dark | The purple and pink [Dracula](https://draculatheme.com) palette |
| Cyberpunk | dark | Neon edges on black, cut corners, a faint grid |
| Gothic | dark | Gold detailing on deep wine and black |

A theme with one mode always uses it, whatever you chose for light or dark.

The themed directions are inspired by [charredbutter's SillyTavern themes](https://ko-fi.com/charredbutter/shop).
If you play in SillyTavern too, they are well worth a look. Nord, Catppuccin and Dracula use
their published palettes, which are MIT licensed.

The themes bring their own fonts from [Fontsource](https://fontsource.org): Bangers, Comic Neue,
Patrick Hand, Caveat, Cinzel, Cormorant Garamond, Orbitron, Rajdhani, Zen Maru Gothic and
Nunito, all under the SIL Open Font License. A device downloads a font only once a theme uses it.

## A world's theme

A world can name a theme in the frontmatter of its `world.md`. While you are in that world
(its page or one of its chats), the whole app switches to it, and switches back when you leave.
**Settings → Appearance → Let worlds choose their theme** turns this off on a device.

```yaml
---
id: …
type: world
name: Rain Port
themePreset: nord
---
```

The names are `standard`, `nord`, `catppuccin`, `sakura`, `halftone`, `picturebook`,
`dracula`, `cyberpunk` and `gothic`. An unknown name is ignored.

## Tokens a world can override

A world can also change single tokens of the novel view under `theme:` in the same frontmatter.
They apply to the novel view of that world's chats, on top of the theme.

```yaml
theme:
  vn-textbox-bg: "rgb(10 20 40 / 85%)"
  vn-name-bg: "#3b6ea5"
  vn-font: "Georgia, serif"
```

Values are plain CSS values. Anything with `url(`, `;`, braces or angle brackets is ignored, so a
shared world cannot load external resources or inject other styles.

| Token | Default | Used for |
|---|---|---|
| `--vn-stage-bg` | dark brown | Stage behind the background image |
| `--vn-textbox-bg` | translucent dark | Text box (any `background` value) |
| `--vn-textbox-color` | light beige | Text in the text box |
| `--vn-textbox-border` | thin light line | Text box border (a full `border` value) |
| `--vn-textbox-radius` | `10px` | Corners of text box and name badge |
| `--vn-textbox-shadow` | `none` | Shadow of the text box (a `box-shadow` value) |
| `--vn-name-bg` | a color per character | Speaker name badge. Set here, it replaces the per-character colors |
| `--vn-name-color` | accent text | Speaker name text |
| `--vn-name-font` | `--font-body` | Speaker name font |
| `--vn-font` | `--font-story` | Text box font |
| `--vn-font-size` | `1.1rem` | Text box font size |
| `--vn-sprite-height` | `78%` | Character image height relative to the stage |
| `--vn-sprite-dim` | `0.55` | Brightness of characters who are not speaking |

`defaultBackground: <id>` in the same frontmatter picks the background a chat starts with,
until the narrator chooses one. Without it, the world's first background is used.

A character file can set its own badge color with `color: "#8e3b46"`. Without it, each
character gets one of six colors that stay readable in light and dark themes.

## Interface tokens

These tokens are **stable v1**: themes set them, and their names and meaning stay the same in
later versions. They are defined in `packages/client/src/global.css`; the built-in themes are in
`themes.css` next to it. Each theme first sets its primitive colors (such as `--sand-50` or
`--nord6`) and then maps every color token below to one of them.

| Token | Default | Used for |
|---|---|---|
| `--color-bg` | warm off-white / near black | Page background |
| `--color-surface` | white / dark grey | Cards, inputs, dialogs |
| `--color-surface-muted` | light sand / darker grey | Sidebar, badges, banners |
| `--color-border` | sand / grey | Borders of cards and dividers |
| `--color-text` | dark brown / light beige | Body text |
| `--color-text-muted` | | Hints, secondary text |
| `--color-accent` | brown / amber | Main buttons, highlights |
| `--color-accent-text` | white / near black | Text on the accent color |
| `--color-danger` | red | Errors, delete |
| `--color-success` | green | Saved and accepted states |
| `--color-user-bubble` | | Your own lines in the log view |
| `--color-diff-add` | pale green | Added lines in canon diffs |
| `--color-diff-remove` | pale red | Removed lines in canon diffs |
| `--color-control-border` | `--color-text-muted` | Borders of inputs, checkboxes and outlined buttons (at least 3:1 against `--color-bg` and `--color-surface`) |
| `--color-focus` | `--color-accent` | Ring around the control that has keyboard focus |
| `--color-hover` | faint dark / light wash | Background of list and menu items under the pointer |
| `--color-danger-text` | white / near black | Text on the danger color, e.g. a dialog's Delete button |
| `--color-backdrop` | translucent black | Behind an open dialog |
| `--font-body` | system UI font | Interface text |
| `--font-story` | Georgia | Story text |
| `--font-heading` | `--font-body` | Headings |
| `--font-brand` | `--font-story` | The name in the sidebar |
| `--heading-transform` | `none` | `text-transform` of headings and the brand |
| `--heading-spacing` | `0` | `letter-spacing` of headings and the brand |
| `--radius` | `8px` | Corners of cards, inputs and buttons |
| `--space` | `12px` | Base spacing |
| `--border-width` | `1px` | Width of borders |
| `--shadow` | `none` | Shadow of cards and dialogs |
| `--shadow-control` | `none` | Shadow of main buttons |
| `--surface-blur` | `none` | `backdrop-filter` of cards and the sidebar |
| `--control-clip` | `none` | `clip-path` of buttons, e.g. cut corners |
| `--control-radius` | `--radius` | Corners of buttons |
| `--control-font` | `--font-body` | Font of buttons and speaker chips |
| `--control-transform` | `none` | `text-transform` of buttons and chips |
| `--control-spacing` | `0` | `letter-spacing` of buttons and chips |
| `--chip-radius` | pill | Corners of the speaker chips |
| `--page-background` | `--color-bg` | Page background, may layer gradients over the color |
| `--header-background` | transparent | Background of the chat header |
| `--header-border` | thin border line | Line under the chat header (a full `border` value) |
| `--sidebar-background` | `--color-surface-muted` | Background of the sidebar |
| `--sidebar-border` | thin border line | Line beside the sidebar (a full `border` value) |
| `--vn-stage-bg` | dark brown | See above |
| `--vn-textbox-bg` | translucent dark | See above |
| `--vn-textbox-color` | light beige | See above |
| `--vn-textbox-border` | thin light line | See above |
| `--vn-textbox-radius` | `10px` | See above |
| `--vn-textbox-shadow` | `none` | See above |
| `--vn-textbox-blur` | `none` | `backdrop-filter` of the text box |
| `--vn-textbox-clip` | `none` | `clip-path` of the text box |
| `--vn-stage-border` | `none` | Frame around the stage (a full `border` value) |
| `--vn-stage-radius` | `--radius` | Corners of the stage |
| `--vn-stage-shadow` | `none` | Shadow of the stage |
| `--vn-stage-clip` | `none` | `clip-path` of the stage |
| `--vn-stage-transform` | `none` | `transform` of the stage, e.g. a slight tilt |
| `--vn-tape` | transparent | A strip of tape across the stage's top edge (any `background` value) |
| `--vn-speech-color` | unset | Color of spoken lines; unset uses `--vn-textbox-color` |
| `--vn-narration-color` | unset | Color of narration; unset uses `--vn-textbox-color` |
| `--vn-name-bg` | accent | See above |
| `--vn-name-color` | accent text | See above |
| `--vn-name-font` | `--font-body` | See above |
| `--vn-name-fill` | unset | One badge background for everyone; unset keeps each character's color |
| `--vn-name-fill-text` | unset | Badge text color that goes with `--vn-name-fill` |
| `--vn-name-size` | `0.85rem` | Font size of the name badge |
| `--vn-name-case` | `none` | `text-transform` of the name badge |
| `--vn-name-transform` | `rotate(0deg)` | Extra `transform` of the name badge, e.g. a tilt |
| `--vn-name-border` | `none` | Border of the name badge |
| `--vn-name-shadow` | `none` | Shadow of the name badge |
| `--vn-name-clip` | `none` | `clip-path` of the name badge, e.g. torn tape ends |
| `--vn-font` | `--font-story` | See above |
| `--vn-font-size` | `1.1rem` | See above |
| `--vn-sprite-height` | `78%` | See above |
| `--vn-sprite-dim` | `0.55` | See above |

A test checks that every theme defines these tokens, that text (also spoken lines and narration)
keeps a contrast of at least 4.5:1, that control borders and the focus ring keep at least 3:1,
and that this list matches `global.css`.

## Building blocks

Dialogs (`Dialog`, `ConfirmDialog`), menus (`Menu`) and symbol buttons (`IconButton`) live in
`packages/client/src/components/` and are styled in `ui.module.css`. They take every color from
the tokens above, never a fixed value, so each theme reaches them; a test fails on a fixed color
in `ui.module.css`. Use them instead of the browser's `prompt()` and `confirm()`, which a test
also rules out.
