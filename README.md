# Animated Background for Home Assistant

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories)
[![Validate](https://github.com/MrVess/ha-animated-background/actions/workflows/validate.yml/badge.svg)](https://github.com/MrVess/ha-animated-background/actions/workflows/validate.yml)

Play a looping **video or image behind your dashboards**. It can change with an entity's state
(weather, sun, alarm, media player, anything), and you can set it per view, per user or per device.

Tested on Home Assistant **2026.11**. Should work on 2024.1 and later.

## Install with HACS

[![Open your Home Assistant instance and open this repository inside HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=MrVess&repository=ha-animated-background&category=plugin)

Or by hand:
1. **HACS → ⋮ → Custom repositories**
2. Repository: `https://github.com/MrVess/ha-animated-background`, Type: **Dashboard**
3. Find **Animated Background** in HACS → **Download**, then reload your browser.

HACS adds the dashboard resource for you.

<details><summary>Manual install (no HACS)</summary>

1. Copy `dist/animated-background.js` to `/config/www/`.
2. Either add a resource (**Settings → Dashboards → ⋮ → Resources → Add**: URL
   `/local/animated-background.js`, type *JavaScript module*), or put this in `configuration.yaml`
   and restart:
   ```yaml
   frontend:
     extra_module_url:
       - /local/animated-background.js?v=1
   ```
</details>

## Add your media
Put videos or images in `/config/www/` (for example `/config/www/backgrounds/rain.mp4`) and refer to
them as `/local/backgrounds/rain.mp4`. Full `https://…` URLs work too.

- **Video** (muted, looping, autoplays on mobile): `.mp4` `.m4v` `.webm` `.mov`
- **Image**: anything else (`.jpg` `.png` `.gif` `.webp` …)

Keep videos short and modest in size (720p/1080p, a few MB). Wall tablets will thank you.

## Configure
Open a dashboard → ✏️ → ⋮ → **Raw configuration editor**, then add an `animated_background:`
block at the **top level** (next to `views:`).

```yaml
animated_background:
  default_url: /local/backgrounds/default.mp4
views:
  ...
```

### Change with an entity's state
```yaml
animated_background:
  entity: weather.home
  default_url: /local/backgrounds/clouds.mp4        # used when no state matches
  state_url:
    sunny: /local/backgrounds/sunny.mp4
    rainy: [/local/backgrounds/rain1.mp4, /local/backgrounds/rain2.webm]   # random pick
    clear-night: none                                # 'none' = normal theme background
```

### Options
| Key | Description |
|---|---|
| `default_url` | URL, or list of URLs (one is picked at random) |
| `entity` | Entity whose state selects the background |
| `state_url` | Map of `state: url`. Values can be a URL, a list, or `none` |
| `background` | CSS colour/gradient drawn **over** the media as a tint, e.g. `rgba(0,0,0,0.3)` |
| `enabled` | `false` to switch off (handy inside a view or group) |
| `included_users` / `excluded_users` | HA user display names |
| `included_devices` / `excluded_devices` | Text matched against the browser user agent (`iPhone`, `Android`, `Windows`, `Macintosh`…) |
| `views` | List of `{ path, config }`. Overrides for a view by its path |
| `groups` | List of `{ name, config }`. Reusable configs. Pick one per view with `animated_background: <name>` in that view, or `none` to disable |
| `debug` | `true` logs decisions to the browser console |

More in [`examples/`](examples/).

### See-through cards
Cards are solid by default. Use a theme with transparent cards, for example
[`examples/theme-transparent-cards.yaml`](examples/theme-transparent-cards.yaml):
```yaml
ha-card-background: rgba(20, 20, 20, 0.35)
```

## Notes
- The built-in auto-generated **Overview/Home** dashboard has no editable config. Use a dashboard
  you created (**Settings → Dashboards → Add dashboard**).
- Some browsers won't autoplay video when battery saver is on.

## Coming from Villhellm's lovelace-animated-background
This is a from-scratch rewrite for the current Home Assistant frontend. It uses the **same YAML
config**, so remove the old resource, install this one, and your existing `animated_background:`
blocks should work unchanged. `background: transparent` (the old default) now does nothing.
`background:` is a tint overlay.

Thanks to [Villhellm](https://github.com/Villhellm) for the original idea and config format.

## License
[MIT](LICENSE). Free to use, change and share.
