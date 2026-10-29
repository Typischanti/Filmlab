"""Projektdateien (*.filmlab), Sitzungswiederherstellung und Undo/Redo.

Projektdateien sind JSON und enthalten nur Verweise auf die Originale sowie
deren Einstellungen – Originaldateien werden nie verändert.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .profiles import user_dir
from .settings import EditSettings

PROJECT_VERSION = 1
PROJECT_SUFFIX = ".filmlab"


@dataclass
class ProjectImage:
    path: str
    settings: EditSettings = field(default_factory=EditSettings)

    @property
    def name(self) -> str:
        return Path(self.path).name


@dataclass
class Project:
    images: list[ProjectImage] = field(default_factory=list)
    current: int = -1
    export: dict[str, Any] = field(default_factory=dict)
    path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        base = Path(self.path).parent if self.path else None
        imgs = []
        for im in self.images:
            entry = {"path": str(Path(im.path).resolve()), "settings": im.settings.to_dict()}
            if base:
                try:
                    entry["relpath"] = os.path.relpath(im.path, base)
                except ValueError:  # anderes Laufwerk (Windows)
                    pass
            imgs.append(entry)
        return {"format": "filmlab-project", "version": PROJECT_VERSION, "saved": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "current": self.current, "export": self.export, "images": imgs}

    @classmethod
    def from_dict(cls, data: dict[str, Any], path: str | None = None) -> "Project":
        if data.get("format") != "filmlab-project":
            raise ValueError("Keine FilmLab-Projektdatei")
        base = Path(path).parent if path else None
        images = []
        for entry in data.get("images", []):
            p = entry.get("path", "")
            if base and entry.get("relpath") and not Path(p).exists():
                cand = (base / entry["relpath"]).resolve()
                if cand.exists():
                    p = str(cand)
            images.append(ProjectImage(p, EditSettings.from_dict(entry.get("settings"))))
        current = int(data.get("current", 0 if images else -1))
        return cls(images, min(current, len(images) - 1), dict(data.get("export", {})), path)

    def save(self, path: str | os.PathLike | None = None) -> Path:
        target = Path(path or self.path or "")
        if not str(target):
            raise ValueError("Kein Speicherort angegeben")
        if path is not None:
            self.path = str(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
        return target

    @classmethod
    def load(cls, path: str | os.PathLike) -> "Project":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data, str(path))


def session_path() -> Path:
    return user_dir() / "session.filmlab"


def save_session(project: Project) -> None:
    data = project.to_dict()
    data["project_path"] = project.path
    p = session_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def load_session() -> Project | None:
    p = session_path()
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        proj = Project.from_dict(data)
        proj.path = data.get("project_path")
        proj.images = [im for im in proj.images if Path(im.path).is_file()]
        proj.current = min(max(proj.current, 0), len(proj.images) - 1)
        return proj
    except (OSError, ValueError, json.JSONDecodeError):
        return None


class History:
    """Undo/Redo über vollständige Einstellungs-Schnappschüsse.
    Aufeinanderfolgende Änderungen mit gleichem ``group`` werden
    zusammengefasst (z.B. ein Reglerzug)."""

    def __init__(self, limit: int = 300):
        self.limit = limit
        self._undo: list[tuple[dict, str]] = []
        self._redo: list[tuple[dict, str]] = []
        self._last_group: str | None = None
        self._last_time = 0.0

    def record(self, before: EditSettings, label: str, group: str | None = None) -> None:
        now = time.monotonic()
        if group is not None and group == self._last_group and now - self._last_time < 1.5 and self._undo:
            self._last_time = now
            return  # gleicher Reglerzug: ursprünglichen Zustand behalten
        self._undo.append((before.to_dict(), label))
        if len(self._undo) > self.limit:
            self._undo.pop(0)
        self._redo.clear()
        self._last_group, self._last_time = group, now

    def undo(self, current: EditSettings) -> EditSettings | None:
        if not self._undo:
            return None
        state, label = self._undo.pop()
        self._redo.append((current.to_dict(), label))
        self._last_group = None
        return EditSettings.from_dict(state)

    def redo(self, current: EditSettings) -> EditSettings | None:
        if not self._redo:
            return None
        state, label = self._redo.pop()
        self._undo.append((current.to_dict(), label))
        self._last_group = None
        return EditSettings.from_dict(state)

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    def undo_label(self) -> str:
        return self._undo[-1][1] if self._undo else ""

    def redo_label(self) -> str:
        return self._redo[-1][1] if self._redo else ""
