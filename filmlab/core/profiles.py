"""Filmprofile und Looks (Presets) als JSON-Dateien.

* Eingebaute Dateien: ``filmlab/resources/{profiles,presets}/*.json``
* Benutzerdateien:    ``~/.filmlab/{profiles,presets}/*.json`` (überschreiben
  eingebaute Dateien mit gleicher ``id``)

Profil = filmbezogene Parameter (``film``) + optionale Look-Abweichungen
(``look_delta``, additiv relativ zum gewählten Preset).
Preset = absolute Look-Parameter (``look``).

Effektiver Look = Standardwerte ⊕ Preset.look ⊕ Profil.look_delta.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .settings import FILM_PARAMS, LOOK_PARAMS, EditSettings, apply_overrides

RESOURCE_DIR = Path(__file__).resolve().parent.parent / "resources"


def user_dir() -> Path:
    return Path.home() / ".filmlab"


@dataclass
class FilmProfile:
    id: str
    name: str
    film_type: str
    manufacturer: str = ""
    iso: int | None = None
    description: str = ""
    basis: str = ""
    film: dict[str, Any] = field(default_factory=dict)
    look_delta: dict[str, float] = field(default_factory=dict)
    recommended_preset: str = "neutral"
    builtin: bool = True
    path: str = ""


@dataclass
class Preset:
    id: str
    name: str
    description: str = ""
    look: dict[str, Any] = field(default_factory=dict)
    builtin: bool = True
    path: str = ""


def _read_dir(sub: str) -> list[tuple[dict, Path, bool]]:
    out = []
    for base, builtin in ((RESOURCE_DIR / sub, True), (user_dir() / sub, False)):
        if not base.is_dir():
            continue
        for f in sorted(base.glob("*.json")):
            try:
                out.append((json.loads(f.read_text(encoding="utf-8")), f, builtin))
            except (OSError, json.JSONDecodeError) as exc:
                print(f"[filmlab] Ignoriere fehlerhafte Datei {f}: {exc}")
    return out


class Library:
    def __init__(self):
        self.profiles: dict[str, FilmProfile] = {}
        self.presets: dict[str, Preset] = {}
        self.reload()

    def reload(self) -> None:
        self.profiles.clear()
        self.presets.clear()
        for data, path, builtin in _read_dir("profiles"):
            try:
                p = FilmProfile(
                    id=data["id"], name=data["name"], film_type=data["film_type"],
                    manufacturer=data.get("manufacturer", ""), iso=data.get("iso"),
                    description=data.get("description", ""), basis=data.get("basis", ""),
                    film={k: v for k, v in data.get("film", {}).items() if k in FILM_PARAMS},
                    look_delta={k: float(v) for k, v in data.get("look_delta", {}).items() if k in LOOK_PARAMS},
                    recommended_preset=data.get("recommended_preset", "neutral"),
                    builtin=builtin, path=str(path),
                )
                self.profiles[p.id] = p
            except (KeyError, TypeError, ValueError) as exc:
                print(f"[filmlab] Profil {path} ungültig: {exc}")
        for data, path, builtin in _read_dir("presets"):
            try:
                pr = Preset(id=data["id"], name=data["name"], description=data.get("description", ""),
                            look={k: v for k, v in data.get("look", {}).items() if k in LOOK_PARAMS},
                            builtin=builtin, path=str(path))
                self.presets[pr.id] = pr
            except (KeyError, TypeError) as exc:
                print(f"[filmlab] Preset {path} ungültig: {exc}")

    # ------------------------------------------------------------------
    def profiles_for(self, film_type: str | None = None) -> list[FilmProfile]:
        items = [p for p in self.profiles.values() if film_type in (None, p.film_type)]
        return sorted(items, key=lambda p: (not p.id.startswith("generic"), p.manufacturer, p.name))

    def resolved_look(self, profile_id: str, preset_id: str) -> dict[str, Any]:
        defaults = EditSettings()
        look: dict[str, Any] = {k: getattr(defaults, k) for k in LOOK_PARAMS}
        preset = self.presets.get(preset_id)
        if preset:
            look.update(preset.look)
        profile = self.profiles.get(profile_id)
        if profile:
            for k, dv in profile.look_delta.items():
                if isinstance(look.get(k), (int, float)):
                    look[k] = float(look[k]) + dv
        return look

    def apply(self, s: EditSettings, profile_id: str | None = None, preset_id: str | None = None) -> EditSettings:
        """Wendet Profil und/oder Preset an (nicht-destruktiv: neue Instanz)."""
        profile_id = profile_id or s.profile_id
        preset_id = preset_id or s.preset_id
        out = s.copy()
        profile = self.profiles.get(profile_id)
        if profile:
            out = apply_overrides(out, {"film_type": profile.film_type, **profile.film}, FILM_PARAMS)
        out = apply_overrides(out, self.resolved_look(profile_id, preset_id), LOOK_PARAMS)
        out.profile_id, out.preset_id = profile_id, preset_id
        return out

    def save_user_preset(self, preset_id: str, name: str, s: EditSettings, description: str = "") -> Path:
        d = user_dir() / "presets"
        d.mkdir(parents=True, exist_ok=True)
        data = {"id": preset_id, "name": name, "description": description,
                "look": {k: getattr(s, k) for k in sorted(LOOK_PARAMS)}}
        path = d / f"{preset_id}.json"
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        self.reload()
        return path


_LIBRARY: Library | None = None


def library() -> Library:
    global _LIBRARY
    if _LIBRARY is None:
        _LIBRARY = Library()
    return _LIBRARY
