# Changelog

All notable changes to the "vscode-backseat-debug" extension will be documented in this file.

## [0.4.0] - 2022-10-10

### Added

* Added bssembler syntax highlighting provided by coder2k (mgerhold).

## [0.3.2] - 2022-10-10

### Changed

* Moved repository to github organisation Backseating-Committee-2k.
* Updated all extension links in `package.json`.

## [0.3.1] - 2022-10-09

### Added

* Updated packaged emulator binary.

## [0.3.0] - 2022-10-09

### Added

* Call stack is now shown while debugging.
* Added example `call.bsm` to the repo that makes use of a call stack.

## [0.2.8] - 2022-10-09

### Added

* Graceful shutdown of emulator before sending kill signals to process.
* Added timeout setting entries `backseat-debug.bssemblerTimeout` and `backseat-debug.emulatorTimeout`.

### Fixed

* Correct forced shutdown with kill signals for emulator process that is started with `exec` instead of `spawn`. This can only be done if we know the `pid` of the emulator which gets sent after connecting to the debugger TCP interface.

## [0.2.7] - 2022-10-09

### Added

* Logging settings to the "Backseat Debug" output channel at debugger start.

## [0.2.6] - 2022-10-09

### Added

* Logging commands to the "Backseat Debug" output channel before they are executed.

## [0.2.5] - 2022-10-09

### Added

* Updated packaged emulator and bssembler binaries.

## [0.2.4] - 2022-10-08

### Fixed

* Fixed "hello world" example `.bsm` applications in the repo to use the length of a string.
* Fixed stopping on unknown lines: if the emulator stops at an unknown address, the client can now step or continue but the current line will not be indicated.

## [0.2.3] - 2022-10-08

### Added

* Added setting entries `backseat-debug.bssemblerExternalPath`, `backseat-debug.emulatorExternalPath`, `backseat-debug.emulatorExternalPathNoGraphics`, `backseat-debug.bssemblerDefaultCommand` and, `backseat-debug.emulatorDefaultCommand`.
* Added example of an endless running `.bsm` application to the repo.

## [0.2.2] - 2022-10-08

### Added

* Registers can now be changed in the variables section while debugging.

## [0.2.1] - 2022-10-07

### Fixed

* Fixed some breakpoint bugs.

## [0.2.0] - 2022-10-05

### Added

* Register values are retrieved an displayed in the variable section while debugging.

## [0.1.4] - 2022-10-03

### Added

* Added a "no graphics" option, which allows debugging without the emulator window.

### Fixed

* Debugger now correctly launches for `.bsm` files when pressing F5 in a workspace without launch.json.

## [0.1.3] - 2022-10-03

### Added

* Implemented "stop on entry".
* "Debug File" command automatically stops on first instruction.
* `launch.json` targets can be configured to stop on first instruction.

## [0.1.2] - 2022-10-03

### Fixed

* Fixed breakpoint changes working incorrectly.

## [0.1.1] - 2022-10-03

### Added

* Added output channel "Backseat Debug" for extension.
* Bssembler and emulator process output is forwarded to output channel.

## [0.1.0] - 2022-10-03

### Added

* Basic debugging support for bssembler.
