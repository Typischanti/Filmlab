"""Startpunkt der Desktop-Anwendung."""
from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="filmlab", description="FilmLab Negativ-Konverter")
    ap.add_argument("files", nargs="*", help="Bilder oder .filmlab-Projekt öffnen")
    ap.add_argument("--no-session", action="store_true", help="letzte Sitzung nicht wiederherstellen")
    args = ap.parse_args(argv)

    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    from .ui.main_window import MainWindow
    from .ui.theme import apply_theme

    app = QApplication.instance() or QApplication(sys.argv[:1])
    app.setApplicationName("FilmLab")
    app.setOrganizationName("FilmLab")
    apply_theme(app)
    win = MainWindow(restore_session=not args.files and not args.no_session)
    win.show()
    if args.files:
        projects = [f for f in args.files if f.endswith(".filmlab")]
        if projects:
            QTimer.singleShot(0, lambda: win.open_project(projects[0]))
        else:
            QTimer.singleShot(0, lambda: win.add_files(args.files))
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
