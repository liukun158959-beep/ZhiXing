"""仅管理本任务创建的进程树，不触碰飞书 CLI 的共享事件总线。"""
import ctypes
import os
import subprocess
import threading


class ProcessTree:
    def __init__(self, process):
        self.process = process
        self._close_lock = threading.Lock()
        self.job = None
        if os.name == "nt":
            from ctypes import wintypes as w
            class Basic(ctypes.Structure):
                _fields_ = [("a", ctypes.c_int64), ("b", ctypes.c_int64), ("flags", w.DWORD),
                            ("min", ctypes.c_size_t), ("max", ctypes.c_size_t), ("active", w.DWORD),
                            ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
            class IO(ctypes.Structure):
                _fields_ = [(name, ctypes.c_uint64) for name in ("r", "w", "o", "rb", "wb", "ob")]
            class Limits(ctypes.Structure):
                _fields_ = [("basic", Basic), ("io", IO), ("pm", ctypes.c_size_t),
                            ("jm", ctypes.c_size_t), ("pp", ctypes.c_size_t), ("pj", ctypes.c_size_t)]
            dll = ctypes.WinDLL("kernel32", use_last_error=True)
            dll.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
            dll.CreateJobObjectW.restype = w.HANDLE
            dll.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
            dll.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
            dll.CloseHandle.argtypes = [w.HANDLE]
            self.dll = dll
            job = dll.CreateJobObjectW(None, None)
            info = Limits()
            info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not job or not dll.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                if job:
                    dll.CloseHandle(job)
                process.kill()
                raise OSError("无法建立任务进程保护。")
            if not dll.AssignProcessToJobObject(job, w.HANDLE(int(process._handle))):
                dll.CloseHandle(job)
                process.kill()
                raise OSError("无法隔离任务子进程。")
            self.job = job

    def close(self):
        with self._close_lock:
            self._close()

    def _close(self):
        if self.job:
            self.dll.CloseHandle(self.job)
            self.job = None
        elif self.process.poll() is None:
            self.process.kill()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
