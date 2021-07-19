import {EmulatorWorkerConfig, InputBufferAddresses} from "./emulator-common";
import BasiliskIIPath from "./BasiliskII.jsz";
import BasiliskIIWasmPath from "./BasiliskII.wasmz";
import {EmulatorWorkerAudio} from "./emulator-worker-audio";
import {EmulatorWorkerInput} from "./emulator-worker-input";
import {EmulatorWorkerVideo} from "./emulator-worker-video";

declare const Module: EmscriptenModule;

self.onmessage = function (msg) {
    startEmulator(msg.data);
};

class EmulatorWorkerApi {
    InputBufferAddresses = InputBufferAddresses;

    #video: EmulatorWorkerVideo;
    #input: EmulatorWorkerInput;
    #audio: EmulatorWorkerAudio;

    #lastBlitFrameId = 0;
    #lastBlitFrameHash = 0;
    #nextExpectedBlitTime = 0;
    #lastIdleWaitFrameId = 0;

    constructor(config: EmulatorWorkerConfig) {
        this.#video = new EmulatorWorkerVideo(config.video);
        this.#input = new EmulatorWorkerInput(config.input);
        this.#audio = new EmulatorWorkerAudio(config.audio);
    }

    blit(
        bufPtr: number,
        width: number,
        height: number,
        depth: number,
        usingPalette: number,
        hash: number
    ) {
        this.#lastBlitFrameId++;
        if (hash !== this.#lastBlitFrameHash) {
            this.#lastBlitFrameHash = hash;
            const length = width * height * (depth === 32 ? 4 : 1); // 32bpp or 8bpp
            const data = Module.HEAPU8.subarray(bufPtr, bufPtr + length);
            this.#video.blit(data, width, height, depth, usingPalette);
        }
        this.#nextExpectedBlitTime = performance.now() + 16;
    }

    openAudio(
        sampleRate: number,
        sampleSize: number,
        channels: number,
        framesPerBuffer: number
    ) {
        this.#audio.openAudio(
            sampleRate,
            sampleSize,
            channels,
            framesPerBuffer
        );
    }

    enqueueAudio(bufPtr: number, nbytes: number, type: number): number {
        const newAudio = Module.HEAPU8.slice(bufPtr, bufPtr + nbytes);
        return this.#audio.enqueueAudio(newAudio);
    }

    debugPointer(ptr: any) {
        console.log("debugPointer", ptr);
    }

    idleWait() {
        // Don't do more than one call per frame, otherwise we end up skipping
        // frames.
        // TOOD: understand why IdleWait is called multiple times in a row
        // before VideoRefresh is called again.
        if (this.#lastIdleWaitFrameId === this.#lastBlitFrameId) {
            return;
        }
        this.#lastIdleWaitFrameId = this.#lastBlitFrameId;
        this.#input.idleWait(
            this.#nextExpectedBlitTime - performance.now() - 2
        );
    }

    acquireInputLock(): number {
        return this.#input.acquireInputLock();
    }

    releaseInputLock() {
        this.#input.releaseInputLock();
    }

    getInputValue(addr: number): number {
        return this.#input.getInputValue(addr);
    }
}

function startEmulator(config: EmulatorWorkerConfig) {
    const workerApi = new EmulatorWorkerApi(config);

    let totalDependencies = 0;
    const moduleOverrides: Partial<EmscriptenModule> = {
        arguments: config.arguments,
        locateFile(path: string, scriptDirectory: string) {
            if (path === "BasiliskII.wasm") {
                return BasiliskIIWasmPath;
            }
            return scriptDirectory + path;
        },

        preRun: [
            function () {
                for (const [name, path] of Object.entries(
                    config.autoloadFiles
                )) {
                    FS.createPreloadedFile(
                        "/",
                        name,
                        path as string,
                        true,
                        true
                    );
                }
            },
        ],

        onRuntimeInitialized() {
            (globalThis as any).workerApi = workerApi;
        },

        monitorRunDependencies(left: number) {
            totalDependencies = Math.max(totalDependencies, left);

            if (left === 0) {
                postMessage({type: "emulator_ready"});
            } else {
                postMessage({
                    type: "emulator_loading",
                    completion: (totalDependencies - left) / totalDependencies,
                });
            }
        },

        print: console.log.bind(console),

        printErr: console.warn.bind(console),
    };
    (self as any).Module = moduleOverrides;

    importScripts(BasiliskIIPath);
}