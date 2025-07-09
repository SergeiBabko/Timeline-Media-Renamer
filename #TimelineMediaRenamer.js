const fs = require('fs');
const path = require('path');
const util = require('util');
const { exiftool } = require('exiftool-vendored');
const { DateTime } = require('luxon');

const rootPath = __dirname;

class TimelineMediaRenamerSettings {
  /**
   * Enables or disables saving logs during the media sorting process.
   * Set to `true` to keep logs, or `false` to disable logging.
   */
  static SAVE_LOGS = false;

  /**
   * List of folder names to ignore during the scan.
   * Any directory matching a name in this list will be skipped.
   */
  static IGNORED_DIRECTORIES = [
    '#Ignored',
    'node_modules', // DO NOT REMOVE
  ];

  /**
   * List of file names to ignore during the scan.
   * Any file matching a name in this list will be skipped.
   */
  static IGNORED_FILES = [
    '#TimelineMediaRenamer.bat', // DO NOT REMOVE
    '#TimelineMediaRenamer.js',  // DO NOT REMOVE
    '#TimelineMediaSorter.bat',  // DO NOT REMOVE
    '#TimelineMediaSorter.js',   // DO NOT REMOVE
    'package.json',              // DO NOT REMOVE
    'package-lock.json',         // DO NOT REMOVE
  ];

  /**
   * List of recognized photo file extensions.
   * Files with these extensions will be considered image files.
   */
  static PHOTO_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.heic', '.heif',
    '.webp', '.raw', '.arw', '.cr2', '.nef', '.orf', '.sr2', '.dng', '.rw2', '.raf',
    '.psd', '.xcf', '.ai', '.indd', '.svg', '.eps', '.pdf', '.lrtemplate', '.xmp',
  ];

  /**
   * List of recognized video file extensions.
   * Files with these extensions will be considered video files.
   */
  static VIDEO_EXTENSIONS = [
    '.3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.mpeg', '.mpg',
    '.m4v', '.mts', '.m2ts', '.vob', '.rm', '.rmvb', '.asf', '.divx', '.xvid', '.ogv',
    '.ts', '.mxf', '.f4v', '.m2v', '.mpv', '.qt', '.mng', '.yuv', '.y4m', '.drc',
    '.f4p', '.f4a', '.f4b'
  ];

  /**
   * List of folder and file names to remove after the scan.
   * Any directories and files matching a name in this list will be removed.
   */
  static DELETE_ON_COMPLETE = [
    'node_modules',      // DO NOT REMOVE
    'package.json',      // DO NOT REMOVE
    'package-lock.json', // DO NOT REMOVE
  ];

  /**
   * Priority list of local (non-timezone-aware) EXIF tags that represent
   * the capture or creation date of an image or video.
   * These fields are usually written by cameras and editing software
   * without timezone information.
   *
   * The scanner will attempt to read these tags first, in order,
   * before falling back to timezone-aware tags.
   */
  static EXIF_DATES_LOCAL = [
    // Original capture date/time recorded by the camera (no timezone offset)
    'DateTimeOriginal',
    // Duplicate of DateTimeOriginal in some camera models (local time only)
    'DateTimeCreated',
    // IPTC creation date for still images (local time only)
    'DateCreated',
    // Old IPTC field for image creation (local time only)
    'DigitalCreationDateTime',
  ];

  /**
   * Priority list of timezone-aware EXIF/container date tags.
   * These may be in ISO 8601 format or contain explicit timezone offsets.
   * Used as fallback when local date fields are missing.
   *
   * Useful for video formats (e.g. MP4, MOV) and some modern image metadata.
   * Values are expected to be interpreted in their native timezone context.
   */
  static EXIF_DATES_ZONED = [
    // Container creation timestamp (often ISO format with Z or +hh:mm)
    'CreationDate',
    // Media track creation date in MP4/MOV (includes tzoffsetMinutes)
    'MediaCreateDate',
    // Content creation date in video containers (includes tzoffsetMinutes)
    'ContentCreateDate',
    // EXIF/XMP creation timestamp in some formats (may include timezone)
    'CreateDate',
    // EXIF or container modification timestamp (may include timezone)
    'ModifyDate',
    // File system modification time (always UTC-based)
    // 'FileModifyDate', // Disabled by default
    // File system creation time (always UTC-based)
    // 'FileCreateDate', // Disabled by default
  ];
}

class TimelineMediaRenamer {
  #renamedFilesLength = 0;
  #skippedFilesLength = 0;

  #renameFile = util.promisify(fs.rename);
  #readDir = util.promisify(fs.readdir);
  #rm = util.promisify(fs.rm);
  #unlinkFile = util.promisify(fs.unlink);
  #stat = util.promisify(fs.stat);

  async rename() {
    LoggerUtils.printHeader();
    LoggerUtils.cyan(`📂 ${L10n.get(L10n.Keys.SCANNED_DIR)}: ${rootPath}`);
    LoggerUtils.indent('-');
    const performance = await PerformanceWrapper.getCallbackPerformance(this.#renameFiles.bind(this));
    LoggerUtils.indent('-');
    LoggerUtils.cyan(`✅ ${L10n.get(L10n.Keys.RENAMED)}: ${this.#renamedFilesLength}`);
    LoggerUtils.cyan(`⚠️ ${L10n.get(L10n.Keys.SKIPPED)}: ${this.#skippedFilesLength}`);
    LoggerUtils.cyan(`🕒 ${L10n.get(L10n.Keys.OPERATION_TIME)}: ${performance}`);
    LoggerUtils.indent('-');
    LoggerUtils.printFooter();
    if (TimelineMediaRenamerSettings.SAVE_LOGS) {
      LoggerUtils.saveLogsToFile(rootPath, '#TimelineMediaRenamerLogs.txt');
    }
  }

  async #renameFiles() {
    const allFiles = await this.#walkDir(rootPath);

    for (const filePath of allFiles) {
      const fileExt = path.extname(filePath).toLowerCase();
      const supported = this.#isFileSupported(fileExt);

      if (!supported) {
        this.#logWarning(L10n.Keys.UNSUPPORTED_EXT, filePath);
        this.#skippedFilesLength++;
        continue;
      }

      const captureDate = await this.#getCaptureDate(filePath);

      if (!captureDate) {
        this.#logError(L10n.Keys.MISSING_DATE, filePath);
        this.#skippedFilesLength++;
        continue;
      }

      const newFilePath = this.#getNewFilePath(captureDate, fileExt, filePath);

      if (!newFilePath) {
        this.#logWarning(L10n.Keys.ALREADY_RENAMED, filePath, '☑️');
        this.#skippedFilesLength++;
        continue;
      }

      await this.#safeRenameFile(filePath, newFilePath);
    }

    await exiftool.end();
    await this.#cleanup();
  }

  #isFileSupported(fileExt) {
    return TimelineMediaRenamerSettings.PHOTO_EXTENSIONS.includes(fileExt) ||
      TimelineMediaRenamerSettings.VIDEO_EXTENSIONS.includes(fileExt);
  }

  async #getCaptureDate(filePath) {
    try {
      const exif = await exiftool.read(filePath);

      const priorityDates = [
        ...TimelineMediaRenamerSettings.EXIF_DATES_LOCAL,
        ...TimelineMediaRenamerSettings.EXIF_DATES_ZONED,
      ];

      for (const key of priorityDates) {
        const captureDate = exif[key];

        if (captureDate && typeof captureDate === 'object') {
          return { key, captureDate };
        } else if (captureDate && typeof captureDate === 'string') {
          const dateObj = DateTime.fromJSDate(new Date(captureDate));
          if (!dateObj.isValid) continue;

          const exifDateTime = {
            year: dateObj.year,
            month: dateObj.month,
            day: dateObj.day,
            hour: dateObj.hour,
            minute: dateObj.minute,
            second: dateObj.second,
            millisecond: dateObj.millisecond !== 0 ? dateObj.millisecond : undefined,
            tzoffsetMinutes: dateObj.offset,
            rawValue: dateObj.toFormat('yyyy:MM:dd HH:mm:ssZZ'),
            zoneName: dateObj.zoneName,
            inferredZone: false,
            zone: dateObj.zoneName
          };

          return { key, captureDate: exifDateTime };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  #getNewFilePath(captureDate, fileExt, filePath) {
    const formattedDate = this.#formatDate(captureDate);
    const isVideo = TimelineMediaRenamerSettings.VIDEO_EXTENSIONS.includes(fileExt);
    const typePrefix = isVideo ? 'VID' : 'IMG';
    const dir = path.dirname(filePath);
    const originalResolved = fs.realpathSync(filePath);

    let suffix = 0;
    let newFilePath;

    while (true) {
      const suffixStr = suffix > 0 ? `_${suffix}` : '';
      const newFileName = `${typePrefix}_${formattedDate}${suffixStr}${fileExt}`;
      newFilePath = path.join(dir, newFileName);

      if (!fs.existsSync(newFilePath)) break;

      if (newFilePath === filePath || fs.realpathSync(newFilePath) === originalResolved) {
        newFilePath = null;
        break;
      }

      suffix++;
    }

    return newFilePath;
  }

  #formatDate({ key, captureDate }) {
    const rawDate = captureDate.rawValue;
    const offsetTest = /[+-]\d{2}:\d{2}$/;

    let dt = DateTime.fromISO(rawDate, { setZone: true });

    if (!dt.isValid) {
      dt = DateTime.fromObject({
        year: captureDate.year,
        month: captureDate.month,
        day: captureDate.day,
        hour: captureDate.hour,
        minute: captureDate.minute,
        second: captureDate.second,
      }, { zone: captureDate.zoneName });
    }

    const isZoned = TimelineMediaRenamerSettings.EXIF_DATES_ZONED.includes(key);

    if (isZoned) {
      const hasExplicitOffset =
        offsetTest.test(rawDate) ||
        captureDate.tzoffsetMinutes !== 0 ||
        (captureDate.zoneName && captureDate.zoneName !== 'UTC');

      if (!hasExplicitOffset) {
        dt = dt.setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
      }
    }

    return dt.toFormat('yyyy-MM-dd_HH-mm-ss');
  }

  async #safeRenameFile(filePath, newFilePath) {
    try {
      await this.#renameFile(filePath, newFilePath);
      const fromTo = `${filePath} → ${path.basename(newFilePath)}`;
      this.#logSuccess(L10n.Keys.RENAMED, fromTo);
      this.#renamedFilesLength++;
    } catch (err) {
      this.#logError(L10n.Keys.ERROR_RENAMING, filePath, err);
      this.#skippedFilesLength++;
    }
  }

  async #walkDir(dir, fileList = []) {
    let entries;

    try {
      entries = await this.#readDir(dir, { withFileTypes: true });
    } catch (err) {
      this.#logError(L10n.Keys.ERROR_RD_DIR, dir, err);
      return fileList;
    }

    for (const entry of entries) {
      const entryName = entry.name;
      const fullPath = path.join(dir, entryName);

      const isIgnoredDir = entry.isDirectory() && (
        TimelineMediaRenamerSettings.IGNORED_DIRECTORIES
          .some(ignored => ignored.toLowerCase() === entryName.toLowerCase())
        || entryName.startsWith('.')
      );

      const isIgnoredFile = entry.isFile() &&
        TimelineMediaRenamerSettings.IGNORED_FILES
          .some(ignored => ignored.toLowerCase() === entryName.toLowerCase());

      if (isIgnoredDir || isIgnoredFile) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.#walkDir(fullPath, fileList);
      } else {
        fileList.push(fullPath);
      }
    }

    return fileList;
  }

  async #cleanup() {
    for (const entry of TimelineMediaRenamerSettings.DELETE_ON_COMPLETE) {
      const fullPath = path.join(rootPath, entry);
      await this.#deletePathRecursive(fullPath);
    }
  }

  async #deletePathRecursive(targetPath) {
    try {
      const stat = await this.#stat(targetPath);
      if (stat.isDirectory()) {
        const entries = await this.#readDir(targetPath);
        for (const entry of entries) {
          const subPath = path.join(targetPath, entry);
          await this.#deletePathRecursive(subPath);
        }
        await this.#rm(targetPath, { recursive: true });
      } else {
        await this.#unlinkFile(targetPath);
      }
      // LoggerUtils.yellow(`❌ ${L10n.get(L10n.Keys.DELETED)}: ${targetPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // this.#logError(L10n.Keys.ERROR_DELETE, targetPath, err);
      }
    }
  }

  #logSuccess(key, filePath) {
    LoggerUtils.green(`✅ ${L10n.get(key)}: ${filePath}`);
  }

  #logWarning(key, filePath, icon = `⚠️`) {
    LoggerUtils.yellow(`${icon} ${L10n.get(key)}: ${filePath}`);
  }

  #logError(key, filePath, err) {
    const message = err?.message ? `:\n${err.message}` : '';
    LoggerUtils.red(`⛔ ${L10n.get(key)}: ${filePath}${message}`);
  }
}

class PerformanceWrapper {
  static async getCallbackPerformance(callback) {
    const startTime = Date.now();
    await callback().catch(LoggerUtils.red);
    const endTime = Date.now();
    return PerformanceWrapper.#formatPerformance(endTime - startTime);
  }

  static #formatPerformance(ms) {
    const hours = Math.floor(ms / 3600000);
    ms %= 3600000;
    const minutes = Math.floor(ms / 60000);
    ms %= 60000;
    const seconds = Math.floor(ms / 1000);
    const milliseconds = Math.floor(ms % 1000);

    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const padMs = (n) => String(n).padStart(3, '0');

    if (hours) {
      return `${pad(hours)}.${pad(minutes)}.${pad(seconds)}:${padMs(milliseconds)} (h.m.s:ms)`;
    } else if (minutes) {
      return `${pad(minutes)}.${pad(seconds)}:${padMs(milliseconds)} (m.s:ms)`;
    } else if (seconds) {
      return `${seconds}:${padMs(milliseconds)} (s:ms)`;
    } else {
      return `${milliseconds} (ms)`;
    }
  }
}

class L10n {
  static Keys = Object.freeze({
    // Console messages
    RENAMED: 'renamed',
    SKIPPED: 'skipped',
    DELETED: 'deleted',
    SCANNED_DIR: 'directory',
    MISSING_DATE: 'missingDate',
    UNSUPPORTED_EXT: 'unsupported',
    ALREADY_RENAMED: 'alreadyRenamed',
    ERROR_RENAMING: 'errorRenaming',
    ERROR_DELETE: 'errorDelete',
    ERROR_RD_DIR: 'errorRdFolder',
    OPERATION_TIME: 'operationTime',
  });

  static Translations = Object.freeze({
    // Console messages
    [L10n.Keys.RENAMED]: { ru: 'Переименовано', en: 'Renamed' },
    [L10n.Keys.SKIPPED]: { ru: 'Пропущено', en: 'Skipped' },
    [L10n.Keys.DELETED]: { ru: 'Удалено', en: 'Deleted' },
    [L10n.Keys.SCANNED_DIR]: { ru: 'Сканируемая папка', en: 'Scanned Directory' },
    [L10n.Keys.MISSING_DATE]: { ru: 'Не удалось извлечь дату', en: 'Failed to extract date' },
    [L10n.Keys.UNSUPPORTED_EXT]: { ru: 'Пропущен файл с неподдерживаемым расширением', en: 'Skipped file with unsupported extension' },
    [L10n.Keys.ALREADY_RENAMED]: { ru: 'Файл уже переименован', en: 'File already renamed' },
    [L10n.Keys.ERROR_RENAMING]: { ru: 'Ошибка при переименовании', en: 'Error renaming' },
    [L10n.Keys.ERROR_DELETE]: { ru: 'Ошибка удаления', en: 'Error deleting' },
    [L10n.Keys.ERROR_RD_DIR]: { ru: 'Ошибка при чтении папки', en: 'Failed to read the folder' },
    [L10n.Keys.OPERATION_TIME]: { ru: 'Время выполнения', en: 'Execution time' },
  });

  static Language = (Intl.DateTimeFormat().resolvedOptions().locale || 'en').startsWith('ru') ? 'ru' : 'en';

  static get(key) {
    return L10n.Translations[key]?.[L10n.Language] || key;
  }
}

class LoggerUtils {
  static #logText = '';

  static printHeader() {
    LoggerUtils.clear();
    LoggerUtils.magenta(
      `╔═══════════════════════════════╗
║     Timeline Media Renamer    ║
╚═══════════════════════════════╝`
    );
    LoggerUtils.indent();
  }

  static printFooter() {
    LoggerUtils.indent();
    LoggerUtils.magenta(
      `╔═══════════════════════════════╗
║      Thank You For Using      ║
║    Timeline Media Renamer     ║
║                               ║
║      © 2025 Sergei Babko      ║
║      All Rights Reserved      ║
╚═══════════════════════════════╝`
    );
    LoggerUtils.indent();
  }

  static clear() {
    console.clear();
  }

  static log(...args) {
    console.log(...args);
    LoggerUtils.saveToLogs(...args);
  }

  static indent(symbol) {
    LoggerUtils.log(symbol ? symbol.repeat(100) : '');
  }

  static cyan(message) {
    LoggerUtils.log('\x1b[96m%s\x1b[0m', message);
  }

  static green(message) {
    LoggerUtils.log('\x1b[92m%s\x1b[0m', message);
  }

  static yellow(message) {
    LoggerUtils.log('\x1b[93m%s\x1b[0m', message);
  }

  static red(message) {
    LoggerUtils.log('\x1b[91m%s\x1b[0m', message);
  }

  static magenta(message) {
    LoggerUtils.log('\x1b[95m%s\x1b[0m', message);
  }

  static saveToLogs(...args) {
    args.forEach(arg => {
      if (
        typeof arg !== 'string' ||
        !/^\x1B\[[0-9;]*m%s\x1B\[0m$/.test(arg)
      ) {
        LoggerUtils.#logText += arg + '\n';
      }
    });
  }

  static getLogs() {
    return LoggerUtils.#logText;
  }

  static saveLogsToFile(rootPath, fileName) {
    const logText = LoggerUtils.getLogs();
    const targetPath = path.join(rootPath, fileName);
    fs.writeFileSync(targetPath, logText, 'utf-8');
  }
}

new TimelineMediaRenamer().rename();
