const fs = require('fs');
const path = require('path');
const util = require('util');
const { exiftool } = require('exiftool-vendored');
const { DateTime } = require('luxon');

const rootPath = __dirname;

class TimelineMediaRenamerSettings {
  static SAVE_LOGS = true;

  static PHOTO_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.heic', '.heif',
    '.webp', '.raw', '.arw', '.cr2', '.nef', '.orf', '.sr2', '.dng', '.rw2', '.raf',
    '.psd', '.xcf', '.ai', '.indd', '.svg', '.eps', '.pdf', '.lrtemplate', '.xmp',
  ];

  static VIDEO_EXTENSIONS = [
    '.3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.mpeg', '.mpg',
    '.m4v', '.mts', '.m2ts', '.vob', '.rm', '.rmvb', '.asf', '.divx', '.xvid', '.ogv',
    '.ts', '.mxf', '.f4v', '.m2v', '.mpv', '.qt', '.mng', '.yuv', '.y4m', '.drc',
    '.f4p', '.f4a', '.f4b',
  ];

  static IGNORE_DIRECTORIES = [
    '#Ignored',
    'node_modules',
    '.git',
    '.idea',
  ];

  static DELETE_ON_COMPLETE = [
    'node_modules',
    'package.json',
    'package-lock.json',
  ];

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
    'FileModifyDate',
    // File system creation time (always UTC-based)
    'FileCreateDate',
  ];
}

const TranslationKeys = Object.freeze({
  DIRECTORY: 'directory',
  UNSUPPORTED: 'unsupported',
  RENAMED: 'renamed',
  SKIPPED: 'skipped',
  MISSING_DATE: 'missingDate',
  ALREADY_RENAMED: 'alreadyRenamed',
  ERROR_RENAMING: 'errorRenaming',
  DELETING: 'deleting',
  DELETE_ERROR: 'deleteError',
  OPERATION_TIME: 'operationTime',
});

const Translations = Object.freeze({
  [TranslationKeys.DIRECTORY]: { ru: 'Сканируемая папка', en: 'Scanned Directory' },
  [TranslationKeys.UNSUPPORTED]: { ru: 'Пропущен файл с неподдерживаемым расширением', en: 'Skipped file with unsupported extension' },
  [TranslationKeys.RENAMED]: { ru: 'Переименовано', en: 'Renamed' },
  [TranslationKeys.SKIPPED]: { ru: 'Пропущено', en: 'Skipped' },
  [TranslationKeys.MISSING_DATE]: { ru: 'Не удалось извлечь дату', en: 'Failed to extract date' },
  [TranslationKeys.ALREADY_RENAMED]: { ru: 'Файл уже переименован', en: 'File already renamed' },
  [TranslationKeys.ERROR_RENAMING]: { ru: 'Ошибка при переименовании', en: 'Error renaming' },
  [TranslationKeys.DELETING]: { ru: 'Удалено', en: 'Deleted' },
  [TranslationKeys.DELETE_ERROR]: { ru: 'Ошибка удаления', en: 'Error deleting' },
  [TranslationKeys.OPERATION_TIME]: { ru: 'Время выполнения', en: 'Execution time' },
});

class TimelineMediaRenamer {
  #renamedFilesLength = 0;
  #skippedFilesLength = 0;
  #lang = (Intl.DateTimeFormat().resolvedOptions().locale || 'en').startsWith('ru') ? 'ru' : 'en';

  #renameFile = util.promisify(fs.rename);
  #rmDir = util.promisify(fs.rmdir);
  #unlinkFile = util.promisify(fs.unlink);
  #stat = util.promisify(fs.stat);
  #readdir = util.promisify(fs.readdir);

  async renameFiles() {
    LoggerUtils.printHeader();
    LoggerUtils.cyan(`📂 ${this.#l10n(TranslationKeys.DIRECTORY)}: ${rootPath}`);
    LoggerUtils.indent('-');
    await this.#performanceWrapper(this.#renameFiles.bind(this));
    LoggerUtils.printFooter();
    if (TimelineMediaRenamerSettings.SAVE_LOGS) {
      LoggerUtils.saveLogsToFile(rootPath, '#TimelineMediaRenamerLogs.txt');
    }
  }

  async #renameFiles() {
    const allFiles = await this.#walkDir(rootPath);

    for (const filePath of allFiles) {
      const ext = path.extname(filePath).toLowerCase();

      if (
        !TimelineMediaRenamerSettings.PHOTO_EXTENSIONS.includes(ext) &&
        !TimelineMediaRenamerSettings.VIDEO_EXTENSIONS.includes(ext)
      ) {
        this.#skippedFilesLength++;
        LoggerUtils.yellow(`⚠️ ${this.#l10n(TranslationKeys.UNSUPPORTED)}: ${filePath}`);
        continue;
      }

      const captureDate = await this.#getCaptureDate(filePath);

      if (!captureDate) {
        this.#skippedFilesLength++;
        LoggerUtils.red(`⛔ ${this.#l10n(TranslationKeys.MISSING_DATE)}: ${filePath}`);
        continue;
      }

      const formattedDate = this.#formatDate(captureDate);
      const isVideo = TimelineMediaRenamerSettings.VIDEO_EXTENSIONS.includes(ext);
      const typePrefix = isVideo ? 'VID' : 'IMG';
      const dir = path.dirname(filePath);
      const originalResolved = fs.realpathSync(filePath);

      let suffix = 0;
      let newFilePath;

      while (true) {
        const suffixStr = suffix > 0 ? `_${suffix}` : '';
        const newFileName = `${typePrefix}_${formattedDate}${suffixStr}${ext}`;
        newFilePath = path.join(dir, newFileName);

        if (!fs.existsSync(newFilePath)) break;

        if (newFilePath === filePath || fs.realpathSync(newFilePath) === originalResolved) {
          newFilePath = null;
          this.#skippedFilesLength++;
          LoggerUtils.yellow(`☑️ ${this.#l10n(TranslationKeys.ALREADY_RENAMED)}: ${filePath}`);
          break;
        }

        suffix++;
      }

      if (!newFilePath) {
        // Already renamed
        continue;
      }

      try {
        await this.#renameFile(filePath, newFilePath);
        this.#renamedFilesLength++;
        LoggerUtils.green(`✅ ${this.#l10n(TranslationKeys.RENAMED)}: ${filePath} → ${path.basename(newFilePath)}`);
      } catch (err) {
        this.#skippedFilesLength++;
        LoggerUtils.red(`⛔ ${this.#l10n(TranslationKeys.ERROR_RENAMING)}: ${filePath}: ${err.message}`);
      }
    }

    await exiftool.end();
    await this.#cleanup();
  }

  #l10n(key) {
    return Translations[key]?.[this.#lang] || key;
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
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  #formatDate({ key, captureDate }) {
    let dt = DateTime.fromObject({
      year: captureDate.year,
      month: captureDate.month,
      day: captureDate.day,
      hour: captureDate.hour,
      minute: captureDate.minute,
      second: captureDate.second,
    }, { zone: captureDate.zoneName });

    const isZoned = TimelineMediaRenamerSettings.EXIF_DATES_ZONED.includes(key);

    if (isZoned && captureDate.zoneName === 'UTC') {
      dt = dt.setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    }

    return dt.toFormat('yyyy-MM-dd_HH-mm-ss');
  }

  async #walkDir(dir, fileList = []) {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      if (TimelineMediaRenamerSettings.IGNORE_DIRECTORIES.includes(file)) {
        continue;
      }

      const fullPath = path.join(dir, file);
      const stat = await fs.promises.stat(fullPath);
      if (stat.isDirectory()) {
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
      try {
        const stat = await this.#stat(fullPath);
        if (stat.isDirectory()) {
          await this.#removeDirRecursive(fullPath);
        } else {
          await this.#unlinkFile(fullPath);
        }
        // LoggerUtils.yellow(`❌ ${this.#l10n(TranslationKeys.DELETING)}: ${fullPath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // LoggerUtils.red(`⛔ ${this.#l10n(TranslationKeys.DELETE_ERROR)}: ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  async #removeDirRecursive(dir) {
    const entries = await this.#readdir(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await this.#stat(fullPath);
      if (stat.isDirectory()) {
        await this.#removeDirRecursive(fullPath);
      } else {
        await this.#unlinkFile(fullPath);
      }
    }
    await this.#rmDir(dir);
  }

  async #performanceWrapper(callback) {
    const startTime = Date.now();
    await callback().catch(LoggerUtils.red);
    const endTime = Date.now();
    const performance = this.#formatPerformance(endTime - startTime);
    LoggerUtils.indent('-');
    LoggerUtils.cyan(`✅ ${this.#l10n(TranslationKeys.RENAMED)}: ${this.#renamedFilesLength}`);
    LoggerUtils.cyan(`⚠️ ${this.#l10n(TranslationKeys.SKIPPED)}: ${this.#skippedFilesLength}`);
    LoggerUtils.cyan(`🕒 ${this.#l10n(TranslationKeys.OPERATION_TIME)}: ${performance}`);
    LoggerUtils.indent('-');
    LoggerUtils.indent();
  }

  #formatPerformance(ms) {
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

class LoggerUtils {
  static #logs = [];

  static printHeader() {
    this.clear();
    this.magenta(
      `╔═══════════════════════════════╗
║     Timeline Media Renamer    ║
╚═══════════════════════════════╝`
    );
    this.indent();
  }

  static printFooter() {
    this.magenta(
      `╔═══════════════════════════════╗
║      Thank You For Using      ║
║    Timeline Media Renamer     ║
║                               ║
║      © 2025 Sergei Babko      ║
║      All Rights Reserved      ║
╚═══════════════════════════════╝`
    );
    this.indent();
  }

  static clear() {
    console.clear();
  }

  static log(...args) {
    console.log(...args);
    this.saveToLogs(...args);
  }

  static indent(symbol) {
    LoggerUtils.log(symbol ? symbol.repeat(100) : '');
  }

  static cyan(message) {
    this.log('\x1b[96m%s\x1b[0m', message);
  }

  static green(message) {
    this.log('\x1b[92m%s\x1b[0m', message);
  }

  static yellow(message) {
    this.log('\x1b[93m%s\x1b[0m', message);
  }

  static red(message) {
    this.log('\x1b[91m%s\x1b[0m', message);
  }

  static magenta(message) {
    this.log('\x1b[95m%s\x1b[0m', message);
  }

  static saveToLogs(...args) {
    args.forEach(arg => {
      if (
        typeof arg !== 'string' ||
        !/^\x1B\[[0-9;]*m%s\x1B\[0m$/.test(arg)
      ) {
        this.#logs.push(arg);
      }
    });
  }

  static getLogs() {
    return this.#logs;
  }

  static getLogsText() {
    return this.getLogs().join('\n');
  }

  static saveLogsToFile(rootPath, fileName) {
    const logText = this.getLogsText();
    const targetPath = path.join(rootPath, fileName);
    fs.writeFileSync(targetPath, logText, 'utf-8');
  }
}

new TimelineMediaRenamer().renameFiles();
