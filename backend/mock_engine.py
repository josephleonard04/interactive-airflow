"""Lightweight approximate airflow field.

Used when OpenFOAM is not installed yet, so the two-engine UI is fully usable
before the real solver is available. The field is a quick superposition of
decaying jets (fans + supply inlets), a gentle pull toward outlets, and
Gaussian temperature contributions from the AC and warm bodies. It is NOT CFD
— it is clearly labelled ``status="mock"`` to the user — but it produces a
plausible, responsive field that mirrors what the accurate engine will refine.
"""

from __future__ import annotations

import math
from typing import Any

AMBIENT_K = 297.15


def _dist(a: list[float], b: list[float]) -> float:
    return math.sqrt(
        (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
    )


def compute_mock_field(case: dict[str, Any], points: list[list[float]]) -> dict[str, list[float]]:
    """Return {velocity:[vx,vy,vz...], temperature:[K...]} for each point."""
    fans = case.get("fans", [])
    inlets = case.get("inlets", [])
    outlets = case.get("outlets", [])
    heat = case.get("heat", [])
    ambient = float(case.get("ambientTemperature", AMBIENT_K))

    velocity: list[float] = []
    temperature: list[float] = []

    for p in points:
        vx = vy = vz = 0.0
        t = ambient

        # Fans: directional jet decaying with distance from the fan.
        for f in fans:
            c = f["center"]
            d = f["direction"]
            speed = float(f.get("speed", 0.0))
            sigma = max(0.6, float(f.get("radius", 0.55)) * 2.5)
            dist = _dist(p, c)
            fall = math.exp(-(dist * dist) / (2 * sigma * sigma))
            vx += d[0] * speed * fall
            vy += d[1] * speed * fall
            vz += d[2] * speed * fall

        # Supply inlets (AC): jet along the inward normal + local cooling.
        for i in inlets:
            c = i["center"]
            n = i["normal"]
            speed = float(i.get("speed", 0.0))
            sigma = 1.8
            dist = _dist(p, c)
            fall = math.exp(-(dist * dist) / (2 * sigma * sigma))
            vx += n[0] * speed * fall
            vy += n[1] * speed * fall
            vz += n[2] * speed * fall
            supply_t = float(i.get("temperature", ambient))
            t += (supply_t - ambient) * fall

        # Outlets: gentle pull toward the exhaust.
        for o in outlets:
            c = o["center"]
            dist = _dist(p, c)
            sigma = 2.0
            fall = math.exp(-(dist * dist) / (2 * sigma * sigma))
            mag = 0.4 * fall
            length = max(dist, 1e-3)
            vx += (c[0] - p[0]) / length * mag
            vy += (c[1] - p[1]) / length * mag
            vz += (c[2] - p[2]) / length * mag

        # Warm bodies / lamp: buoyant warming + slight upward velocity.
        for h in heat:
            c = h["center"]
            sigma = max(0.6, float(h.get("radius", 1.0)))
            dist = _dist(p, c)
            fall = math.exp(-(dist * dist) / (2 * sigma * sigma))
            t += float(h.get("deltaT", 0.0)) * fall
            vy += 0.25 * float(h.get("deltaT", 0.0)) * 0.1 * fall

        velocity.extend([vx, vy, vz])
        temperature.append(t)

    return {"velocity": velocity, "temperature": temperature}
