import "./folder-icon.less";
import "./focus.less";

import { getApi } from "@aidenlx/obsidian-icon-shortcodes";
import { around } from "monkey-around";
import {
  AFItem,
  CachedMetadata,
  debounce,
  EventRef,
  FileExplorer,
  FolderItem,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import { dirname } from "path";

import ALxFolderNote from "../fn-main";
import { afItemMark, isFolder } from "../misc";
import getClickHandler from "./click-handler";

const folderNoteClass = "alx-folder-note";
const folderClass = "alx-folder-with-note";
const emptyFolderClass = "alx-empty-folder";

const focusedFolderCls = "alx-focused-folder";
const focusModeCls = "alx-folder-focus";

/** File Explorer Handler */
export default class FEHandler {
  plugin: ALxFolderNote;
  fileExplorer: FileExplorer;
  clickHandler: (evt: MouseEvent) => void;

  foldersWithIcon = new Set<string>();

  private get shouldSetIcon(): boolean {
    return this.plugin.settings.folderIcon && !!getApi(this.plugin);
  }

  get fncApi() {
    return this.plugin.CoreApi;
  }
  get files() {
    return this.fileExplorer.files;
  }

  private _focusedFolder: FolderItem | null = null;
  get focusedFolder() {
    return this._focusedFolder;
  }
  set focusedFolder(val: FolderItem | null) {
    this._focusedFolder = val;
    this.fileExplorer.dom.navFileContainerEl.toggleClass(focusModeCls, !!val);
  }
  toggleFocusFolder(folder: TFolder | null) {
    const folderItem = folder
      ? (this.getAfItem(folder.path) as FolderItem | null)
      : null;
    if (this.focusedFolder) {
      this._focusFolder(this.focusedFolder, true);
    }
    // if given same folder as current cached, toggle it off
    if (folderItem && folderItem.file.path === this.focusedFolder?.file.path) {
      this.focusedFolder = null;
    } else {
      folderItem && this._focusFolder(folderItem, false);
      this.focusedFolder = folderItem;
    }
  }
  private _focusFolder(folder: FolderItem, revert = false) {
    if (folder.file.isRoot()) throw new Error("Cannot focus on root dir");
    folder.el.toggleClass(focusedFolderCls, !revert);
  }

  constructor(plugin: ALxFolderNote, explorer: FileExplorer) {
    this.plugin = plugin;
    this.clickHandler = getClickHandler(plugin);
    this.fileExplorer = explorer;
    const { vault, metadataCache, workspace } = plugin.app;
    let refs = [] as EventRef[];
    const updateIcon = () => {
      for (const path of this.foldersWithIcon) {
        this.setMark(path);
      }
    };
    // focus folder setup
    refs.push(
      workspace.on("file-menu", (menu, af, source) => {
        if (!(af instanceof TFolder) || af.isRoot()) return;
        menu.addItem((item) =>
          item
            .setTitle("Toggle Focus")
            .setIcon("crossed-star")
            .onClick(() => this.toggleFocusFolder(af)),
        );
      }),
    );
    this.plugin.register(
      () => this.focusedFolder && this.toggleFocusFolder(null),
    );

    // folder note events setup
    refs.push(
      vault.on("create", (af) => af instanceof TFolder && this.setClick(af)),
      vault.on("folder-note:create", (note: TFile, folder: TFolder) => {
        this.setMark(note);
        this.setMark(folder);
        this.setClick(folder);
      }),
      vault.on("folder-note:delete", (note: TFile, folder: TFolder) => {
        this.setMark(note, true);
        this.setMark(folder, true);
      }),
      vault.on("folder-note:rename", () => {
        // fe-item in dom will be reused, do nothing for now
      }),
      vault.on("folder-note:cfg-changed", () => {
        this.markAll(true);
        window.setTimeout(this.markAll, 200);
      }),
      metadataCache.on("changed", (file) => {
        let folder;
        if ((folder = this.fncApi.getFolderFromNote(file))) {
          this.setMark(folder);
        }
      }),
      vault.on("iconsc:initialized", updateIcon),
      vault.on("iconsc:changed", updateIcon),
    );

    if (this.plugin.settings.hideCollapseIndicator) {
      refs.push(
        // empty folder detection
        vault.on("create", (file) => this.setChangedFolder(file.parent.path)),
        vault.on("delete", (file) => {
          let parent = dirname(file.path);
          this.setChangedFolder(parent === "." ? "/" : parent);
        }),
        vault.on("rename", (file, oldPath) => {
          this.setChangedFolder(file.parent.path);
          let parent = dirname(oldPath);
          this.setChangedFolder(parent === "." ? "/" : parent);
        }),
      );
    }
    refs.forEach((ref) => this.plugin.registerEvent(ref));
  }

  private setMarkQueue: Map<string, boolean> = new Map();
  private updateMark = debounce(
    () => {
      if (this.setMarkQueue.size > 0) {
        this.setMarkQueue.forEach((revert, path) =>
          this._setMark(path, revert),
        );
        this.setMarkQueue.clear();
      }
    },
    200,
    true,
  );
  private _setMark = (path: string, revert: boolean) => {
    const item = this.getAfItem(path);
    if (!item) {
      console.warn("no afitem found for path %s, escaping...", path);
      return;
    }
    if (isFolder(item)) {
      if (revert === !!item.isFolderWithNote) {
        item.el.toggleClass(folderClass, !revert);
        item.isFolderWithNote = revert ? undefined : true;
        if (this.plugin.settings.hideCollapseIndicator)
          item.el.toggleClass(
            emptyFolderClass,
            revert ? false : item.file.children.length === 1,
          );
      }
      this._updateIcon(path, revert, item);
    } else if (revert === !!item.isFolderNote) {
      item.el.toggleClass(folderNoteClass, !revert);
      item.isFolderNote = revert ? undefined : true;
    }
  };
  setMark = (target: AFItem | TAbstractFile | string, revert = false) => {
    if (!target) return;
    if (target instanceof TAbstractFile) {
      this.setMarkQueue.set(target.path, revert);
    } else if (typeof target === "string") {
      this.setMarkQueue.set(target, revert);
    } else {
      this.setMarkQueue.set(target.file.path, revert);
    }
    this.updateMark();
  };

  private setClickQueue: Map<
    string,
    [folder: AFItem | TFolder, revert: boolean]
  > = new Map();
  private updateClick = debounce(
    () => {
      if (this.setClickQueue.size > 0) {
        this.setClickQueue.forEach((param) => this._setClick(...param));
        this.setClickQueue.clear();
      }
    },
    200,
    true,
  );
  /**
   * @param revert when revert is true, set item.evtDone to undefined
   */
  _setClick = (target: AFItem | TFolder, revert = false) => {
    const item: afItemMark | null =
      target instanceof TFolder ? this.getAfItem(target.path) : target;
    if (!item) {
      console.error("item not found with path %s", target);
      return;
    }
    if (isFolder(item)) {
      if (revert) {
        item.evtDone = undefined;
      } else if (!item.evtDone) {
        const { titleInnerEl } = item;
        // handle regular click
        this.plugin.registerDomEvent(titleInnerEl, "click", this.clickHandler);
        // handle middle click
        this.plugin.registerDomEvent(
          titleInnerEl,
          "auxclick",
          this.clickHandler,
        );
        item.evtDone = true;
      }
    }
  };
  setClick = (target: AFItem | TFolder, revert = false) => {
    if (!target) return;
    if (target instanceof TFolder) {
      this.setClickQueue.set(target.path, [target, revert]);
    } else {
      this.setClickQueue.set(target.file.path, [target, revert]);
    }
    this.updateClick();
  };

  private setChangedFolderQueue: Set<string> = new Set();
  private updateChangedFolder = debounce(
    () => {
      if (this.setChangedFolderQueue.size > 0) {
        console.log(this.setChangedFolderQueue);
        this.setChangedFolderQueue.forEach((path) => {
          let note = this.fncApi.getFolderNote(path);
          if (note) {
            (this.getAfItem(path) as FolderItem)?.el.toggleClass(
              emptyFolderClass,
              note.parent.children.length === 1,
            );
          }
        });
        this.setChangedFolderQueue.clear();
      }
    },
    200,
    true,
  );
  setChangedFolder = (folderPath: string) => {
    if (!folderPath || folderPath === "/") return;
    this.setChangedFolderQueue.add(folderPath);
    this.updateChangedFolder();
  };

  private _updateIcon(path: string, revert: boolean, item: afItemMark) {
    if (!this.shouldSetIcon) return;
    const api = getApi(this.plugin) as NonNullable<ReturnType<typeof getApi>>;

    let folderNotePath: string | undefined,
      metadata: CachedMetadata | undefined;
    const revertIcon = () => {
      delete item.el.dataset.icon;
      this.foldersWithIcon.delete(path);
      item.el.style.removeProperty("--alx-folder-icon-txt");
      item.el.style.removeProperty("--alx-folder-icon-url");
    };
    if (revert) {
      revertIcon();
    } else if (
      (folderNotePath = this.fncApi.getFolderNotePath(path)?.path) &&
      (metadata = this.plugin.app.metadataCache.getCache(folderNotePath))
    ) {
      let iconId = metadata.frontmatter?.icon,
        icon;
      if (
        iconId &&
        typeof iconId === "string" &&
        (icon = api.getIcon(iconId, true))
      ) {
        this.foldersWithIcon.add(path);
        item.el.dataset.icon = iconId.replace(/^:|:$/g, "");
        if (!api.isEmoji(iconId)) {
          item.el.style.setProperty("--alx-folder-icon-url", `url("${icon}")`);
          item.el.style.setProperty("--alx-folder-icon-txt", '"  "');
        } else {
          item.el.style.removeProperty("--alx-folder-icon-url");
          item.el.style.setProperty("--alx-folder-icon-txt", `"${icon}"`);
        }
      } else if (item.el.dataset.icon) {
        revertIcon();
      }
    }
  }

  getAfItem = (path: string): afItemMark | null =>
    this.fileExplorer.fileItems[path] ?? null;

  markAll = (revert = false) => {
    this.iterateItems((item: AFItem) => {
      if (isFolder(item) && !revert) {
        this.markFolderNote(item.file);
      } else if (revert) {
        this.setMark(item, true);
      }
    });
  };

  markFolderNote = (af: TAbstractFile): boolean => {
    if (af instanceof TFolder && af.isRoot()) return false;
    const { getFolderNote, getFolderFromNote } = this.fncApi;

    let found: TAbstractFile | null = null;
    if (af instanceof TFile) found = getFolderFromNote(af);
    else if (af instanceof TFolder) found = getFolderNote(af);

    if (found) {
      this.setMark(found);
      this.setMark(af);
    } else {
      this.setMark(af, true);
    }
    return !!found;
  };

  iterateItems = (callback: (item: AFItem) => any): void => {
    const items = this.fileExplorer.fileItems;
    if (items)
      for (const key in items) {
        if (!Object.prototype.hasOwnProperty.call(items, key)) continue;
        callback(items[key]);
      }
  };
}

export const PatchRevealInExplorer = (plugin: ALxFolderNote) => {
  const { getFolderFromNote } = plugin.CoreApi;

  const feInstance =
    plugin.app.internalPlugins.plugins["file-explorer"]?.instance;
  if (feInstance) {
    const remover = around(feInstance, {
      revealInFolder: (next) => {
        return function (this: any, ...args: any[]) {
          if (args[0] instanceof TFile && plugin.settings.hideNoteInExplorer) {
            const findResult = getFolderFromNote(args[0]);
            if (findResult) args[0] = findResult;
          }
          return next.apply(this, args);
        };
      },
    });
    plugin.register(remover);
  }
};
