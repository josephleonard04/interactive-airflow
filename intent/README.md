# intent — natural language → physical objectives

The core contribution. Maps a non-expert's natural-language comfort goal into a structured physical objective the airflow solver/optimizer can act on.

## Objective schema (draft)

```
Objective {
  region:     RegionRef        # e.g. "bed", "desk", "bedroom"
  scalar:     velocity | temperature | co2 | ventilation
  direction:  minimize | maximize | target
  value?:     float            # for `target`
  kind:       hard | soft
  weight?:    float            # for soft constraints
}
```

## Examples

| Goal | Objective(s) |
|------|--------------|
| "keep my bed cool" | minimize `temperature` in `bed` (soft) |
| "bring fresh air to the desk" | maximize `ventilation` / fresh-air exchange in `desk` (soft) |
| "keep the kitchen odor out of my bedroom" | minimize `co2`/contaminant concentration in `bedroom` (hard) |
| "soft wind" | low-magnitude `velocity` target (soft) |

## Initial approach (per advisor direction)

Start with a **domain dictionary**: word/phrase → (scalar, direction). E.g. cool/cold/chilly → temperature↓, warm/cozy → temperature↑, breezy/airy → velocity/ventilation↑, stuffy/stale → ventilation↑. Then attach the matched region. Richer LLM-based parsing and hard/soft constraint reasoning come later.

_TODO: define region model, build the dictionary, then a parser._
