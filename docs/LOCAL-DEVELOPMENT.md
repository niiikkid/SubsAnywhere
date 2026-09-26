# Текущий рабочий режим: локально, без Docker

Для разработки этого проекта на текущем Mac используется **нативный сервер**. Docker оставлен как вариант поставки, но запускать или пересобирать его для обычных локальных изменений не нужно. Не запускайте два сервера на одном порту.

## Сервер

- Адрес: `http://127.0.0.1:43817`, панель обучения: `/words`.
- macOS LaunchAgent: `com.subsanywhere.local-server`.
- Настройки: `~/Library/LaunchAgents/com.subsanywhere.local-server.plist`.
- Автозапуск при входе пользователя и восстановление процесса включены.
- Сервер и ASR используют существующий Python: `~/.hermes/venvs/video-url-to-subtitles/bin/python`.
- Модели остаются прежними: китайский — Fun-ASR-Nano-2512, английский — SenseVoiceSmall, CPU.
- Используются уже имеющиеся модели из `~/.cache/modelscope/hub/models/`; скачивание моделей не требуется.
- `SUBSANYWHERE_RESOURCE_FRACTION=0.5`: на этом Mac с 24 GiB это бюджет 12 GiB и 7 вычислительных потоков. Защита ASR срабатывает на 90% бюджета; это не жёсткая квота всей системы.
- Тяжёлые задания выполняются по одному: `SUBSANYWHERE_MAX_JOBS=1`.
- Лог: `~/Library/Logs/subsanywhere-local-server.log`.

Проверка:

```sh
curl --fail http://127.0.0.1:43817/health
launchctl print gui/$(id -u)/com.subsanywhere.local-server
```

Перезапуск **после завершения текущих заданий**, например после изменения Python-сервера:

```sh
launchctl kickstart -k gui/$(id -u)/com.subsanywhere.local-server
```

После правки самого plist нужно выгрузить службу и загрузить её заново; `kickstart` не перечитывает настройки:

```sh
launchctl bootout gui/$(id -u)/com.subsanywhere.local-server
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.subsanywhere.local-server.plist"
```

Не запускайте параллельно `npm run local-server`: LaunchAgent уже обслуживает нужный порт, а запуск с настройками по умолчанию выберет другие пути данных и бюджет памяти.

## Данные и резервная копия

Текущие рабочие данные:

```text
~/Library/Application Support/SubsAnywhere/data/
  subtitles/       # SRT, аудио, текст и состояние заданий
  words.sqlite3    # слова, предложения, разборы и состояние обучения
```

Копия Docker-данных до переключения:

```text
~/Library/Application Support/SubsAnywhere/backups/docker-<дата-время>/
  data/
  manifest.json
  api-before.json
  native-launchagent-before.plist
```

Сводка переноса: `~/Library/Application Support/SubsAnywhere/migration-report.json`.

При переносе исходный контейнер был штатно остановлен. Все 77 файлов скопированы с проверкой SHA-256, включая 40 SRT. Проверена целостность SQLite, полное совпадение строк базы и API: 931 слово и 6 предложений. Это числа на момент переноса, не ограничение размера словаря.

Оригинальные Docker-тома **не удалены**. Старые нативные файлы `~/Downloads/SubsAnywhere` также не изменялись; активный сервер теперь использует указанную выше отдельную рабочую папку. Новые локальные изменения **не синхронизируются обратно в Docker**. Возвращение к Docker требует отдельного переноса актуальных данных, иначе откроется старая копия словаря.

Docker Desktop выключен, контейнер остановлен. Не используйте `docker compose down -v` или очистку томов.

Cookies из Docker не переносились; автоматическое чтение cookies Chrome отключено. Если YouTube потребует вход, авторизацию нужно настроить отдельно, не удаляя данные.

## Проверенный запуск

После переключения проверены `/health`, страница `/words`, полное совпадение словаря через API, контрольные суммы SRT и локальное получение пиньиня. Та же Nano успешно распознала офлайн 12 секунд ранее упавшей записи; полный ролик заново не запускался. Результаты проверки сохранены в `~/Library/Application Support/SubsAnywhere/verification/`.

Изменения расширения по-прежнему подхватываются через Reload в `chrome://extensions` и обновление страницы. Для одного переключения сервера переустановка или сброс данных расширения не нужны.
