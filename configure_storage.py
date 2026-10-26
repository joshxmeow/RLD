import argparse
import json
import os
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox

from app import STORAGE_CONFIG_PATH


def read_current_data_dir():
    if not STORAGE_CONFIG_PATH.exists():
        return None
    try:
        configuration = json.loads(STORAGE_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read {STORAGE_CONFIG_PATH}: {error}") from error
    data_dir = configuration.get("data_dir") if isinstance(configuration, dict) else None
    if not isinstance(data_dir, str) or not data_dir.strip():
        raise RuntimeError(f"{STORAGE_CONFIG_PATH} does not contain a valid data_dir.")
    return Path(data_dir).expanduser().resolve()


def choose_data_dir():
    current_dir = read_current_data_dir()
    default_dir = current_dir or Path.home() / "Documents" / "RLD Autoworx Data"
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    selected_dir = filedialog.askdirectory(
        parent=root,
        title="Choose where RLD estimates and server keys are saved",
        initialdir=str(default_dir if default_dir.exists() else default_dir.parent),
        mustexist=False,
    )
    root.destroy()
    if not selected_dir:
        return None
    return Path(selected_dir).expanduser().resolve()


def save_data_dir(data_dir):
    STORAGE_CONFIG_PATH.write_text(
        json.dumps({"data_dir": str(data_dir)}, indent=2) + os.linesep,
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(
        description="Choose the Windows folder used for RLD estimates and server keys."
    )
    parser.add_argument(
        "--if-missing",
        action="store_true",
        help="Open the folder picker only when no storage location has been configured.",
    )
    args = parser.parse_args()

    try:
        current_dir = read_current_data_dir()
        if args.if_missing and current_dir is not None:
            print(f"Using existing data folder: {current_dir}")
            return 0
        selected_dir = choose_data_dir()
        if selected_dir is None:
            if current_dir is not None:
                print(f"No change made. Using existing data folder: {current_dir}")
                return 0
            print("No folder selected. Start the server again and choose a data folder.")
            return 1
        save_data_dir(selected_dir)
        if current_dir is not None and current_dir != selected_dir:
            print("The selected location changes the storage location for future server starts.")
            print("Existing data is not moved. The previous folder has been left unchanged.")
        print(f"RLD server data folder set to: {selected_dir}")
        return 0
    except (OSError, RuntimeError, tk.TclError) as error:
        print(f"Could not configure the data folder: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
