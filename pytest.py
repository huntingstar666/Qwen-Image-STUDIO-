"""极简 pytest 兼容运行器（离线环境用；本机没有任何解释器装了 pytest）。

背景：本机 pip / npm 网络不可用，无法安装 pytest，但团队需要统一的测试命令。
本文件放在项目根目录并命名为 pytest.py，因此：

    $PY -m pytest tests -q                 # 全量
    $PY -m pytest tests/test_align.py -v   # 单文件详细
    $PY -m pytest tests -k mask            # 只跑名字含 mask 的用例
    $PY -m pytest tests -x                 # 首个失败即停

支持的 pytest 子集：
    pytest.raises(ExcType[, match=...])   —— 上下文管理器
    pytest.approx(value, rel=, abs=)      —— 数值/序列近似比较
    pytest.fail(msg) / pytest.skip(msg) / pytest.xfail
    pytest.fixture                        —— 装饰器原样返回（本项目约定不用 fixture）
    pytest.mark.<anything>                —— 无操作装饰器
    pytest.warns                         —— 上下文管理器（记录 warning，不强制断言）
    pytest.main(args)                     —— 返回退出码

不支持的：parametrize、conftest.py、fixture 注入、插件。测试请写成纯 assert 函数。

退出码：0 全绿 / 1 有失败 / 5 没收集到用例（与真 pytest 一致）。
"""
from __future__ import annotations

import importlib.util
import math
import os
import re
import sys
import time
import traceback
import warnings

__version__ = "0.0.0-local-shim"

# ---------------------------------------------------------------- 异常类型


class Skipped(Exception):
    """pytest.skip() 抛出。"""


class Failed(AssertionError):
    """pytest.fail() 抛出。"""


class XFailed(Exception):
    """pytest.xfail() 抛出。"""


# ---------------------------------------------------------------- raises


class _RaisesContext:
    def __init__(self, expected, match=None):
        self.expected = expected
        self.match = match
        self.value = None
        self.type = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, tb):
        if exc_type is None:
            names = getattr(self.expected, "__name__", str(self.expected))
            raise Failed(f"DID NOT RAISE {names}")
        if not issubclass(exc_type, self.expected):
            return False  # 让原始异常继续冒泡，便于定位
        self.type = exc_type
        self.value = exc_value
        if self.match is not None and not re.search(self.match, str(exc_value)):
            raise Failed(
                f"异常信息不匹配：期望匹配 {self.match!r}，实际 {str(exc_value)!r}"
            )
        return True


def raises(expected_exception, *args, match=None, **kwargs):
    """支持 pytest.raises(X) 上下文用法，也支持老式 pytest.raises(X, func, ...) 调用。"""
    if not args:
        return _RaisesContext(expected_exception, match=match)
    func, rest = args[0], args[1:]
    with _RaisesContext(expected_exception, match=match):
        return func(*rest, **kwargs)


# ---------------------------------------------------------------- approx


def _core_approx(actual, expected, rel, abs_tol):
    if isinstance(expected, (list, tuple)):
        if not isinstance(actual, (list, tuple)) or len(actual) != len(expected):
            return False
        return all(
            _core_approx(a, e, rel, abs_tol) for a, e in zip(actual, expected)
        )
    try:  # numpy 数组 / 标量
        if hasattr(expected, "shape"):
            import numpy as _np  # noqa: F401  (仅用于类型判断)

            return bool(_np.allclose(actual, expected, rtol=rel, atol=abs_tol))
    except Exception:
        pass
    try:
        a, e = float(actual), float(expected)
    except (TypeError, ValueError):
        return actual == expected
    if math.isnan(e) or math.isnan(a):
        return math.isnan(a) and math.isnan(e)
    if math.isinf(e) or math.isinf(a):
        return a == e
    return abs(a - e) <= max(abs_tol, rel * abs(e))


class Approx:
    __slots__ = ("expected", "rel", "abs")

    def __init__(self, expected, rel=None, abs=None):  # noqa: A002 (对齐 pytest 参数名)
        self.expected = expected
        self.rel = 1e-6 if rel is None else rel
        self.abs = 1e-12 if abs is None else abs

    def __eq__(self, actual):
        return _core_approx(actual, self.expected, self.rel, self.abs)

    def __ne__(self, actual):
        return not self.__eq__(actual)

    def __repr__(self):
        return f"approx({self.expected!r}, rel={self.rel}, abs={self.abs})"


def approx(expected, rel=None, abs=None):  # noqa: A002
    return Approx(expected, rel=rel, abs=abs)


# ---------------------------------------------------------------- 其它 API


def fail(msg="", pytrace=True):
    raise Failed(msg or "pytest.fail()")


def skip(msg="", allow_module_level=False):
    raise Skipped(msg or "skipped")


def xfail(msg=""):
    raise XFailed(msg or "xfail")


def fixture(*args, **kwargs):
    """本项目约定不用 fixture；装饰器原样返回被装饰对象。"""

    def _wrap(func):
        return func

    if len(args) == 1 and callable(args[0]) and not kwargs:
        return args[0]
    return _wrap


class _MarkDecorator:
    def __call__(self, *args, **kwargs):
        if len(args) == 1 and callable(args[0]) and not kwargs:
            return args[0]

        def _wrap(func):
            return func

        return _wrap


class _Mark:
    def __getattr__(self, name):
        return _MarkDecorator()


mark = _Mark()


class _WarnsContext:
    def __enter__(self):
        self._ctx = warnings.catch_warnings(record=True)
        self._list = self._ctx.__enter__()
        warnings.simplefilter("always")
        return self._list

    def __exit__(self, exc_type, exc_value, tb):
        self._ctx.__exit__(exc_type, exc_value, tb)
        return False


def warns(expected_warning, *args, match=None):
    return _WarnsContext()


deprecated_call = warns


# ---------------------------------------------------------------- 收集与执行


def _iter_test_paths(targets):
    found = []
    for target in targets:
        if os.path.isdir(target):
            for root, dirs, files in os.walk(target):
                dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git")]
                for name in sorted(files):
                    if name.startswith("test") and name.endswith(".py"):
                        found.append(os.path.join(root, name))
        elif os.path.isfile(target):
            found.append(target)
        else:
            print(f"警告：路径不存在，已跳过 {target}", file=sys.stderr)
    return found


_MODULE_SEQ = [0]


def _load_module(path):
    _MODULE_SEQ[0] += 1
    mod_name = f"_shim_test_{_MODULE_SEQ[0]}"
    here = os.path.dirname(os.path.abspath(path))
    root = os.path.dirname(here)
    for p in (here, root):
        if p not in sys.path:
            sys.path.insert(0, p)
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载测试模块：{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


def _collect(module):
    """按定义顺序收集 test_* 函数与 Test* 类里的 test_* 方法。"""
    items = []
    for name, obj in vars(module).items():
        if name.startswith("test") and callable(obj) and getattr(obj, "__module__", None) == module.__name__:
            items.append((name, obj, None))
    for name, obj in vars(module).items():
        if isinstance(obj, type) and name.startswith("Test"):
            for mname, mobj in vars(obj).items():
                if mname.startswith("test") and callable(mobj):
                    items.append((f"{name}::{mname}", mobj, obj))
    items.sort(key=lambda it: getattr(it[1], "__code__", None).co_firstlineno if getattr(it[1], "__code__", None) else 0)
    return items


def main(args=None):
    args = list(sys.argv[1:] if args is None else args)

    verbose = "-v" in args or "--verbose" in args
    quiet = "-q" in args or "--quiet" in args
    stop_first = "-x" in args or "--exitfirst" in args
    keyword = None
    if "-k" in args:
        idx = args.index("-k")
        if idx + 1 < len(args):
            keyword = args[idx + 1]
            del args[idx: idx + 2]

    targets = [a for a in args if not a.startswith("-")]
    if not targets:
        targets = ["tests"]

    files = _iter_test_paths(targets)
    if not files:
        print("no tests ran（未收集到用例）")
        return 5

    passed = failed = skipped = xfailed = 0
    failures = []
    t_start = time.time()

    for path in files:
        rel = os.path.relpath(path)
        try:
            module = _load_module(path)
        except Skipped as exc:
            if not quiet:
                print(f"{rel}: 跳过（{exc}）")
            skipped += 1
            continue
        except Exception:
            failed += 1
            failures.append((f"{rel}::<import>", sys.exc_info()))
            print(f"E  导入失败 {rel}")
            if stop_first:
                break
            continue

        items = _collect(module)
        if not items and not quiet:
            print(f"{rel}: 没有 test_* 用例")

        for display, func, cls in items:
            if keyword and keyword not in display:
                continue
            full = f"{rel}::{display}"
            try:
                if cls is None:
                    func()
                else:
                    func(cls())
                passed += 1
                if verbose:
                    print(f"{full} PASSED")
                elif not quiet:
                    print(".", end="", flush=True)
            except Skipped:
                skipped += 1
                if verbose:
                    print(f"{full} SKIPPED")
                elif not quiet:
                    print("s", end="", flush=True)
            except XFailed:
                xfailed += 1
                if verbose:
                    print(f"{full} XFAIL")
            except BaseException:
                failed += 1
                failures.append((full, sys.exc_info()))
                if verbose:
                    print(f"{full} FAILED")
                else:
                    print("F", end="", flush=True)
                if stop_first:
                    break
        if stop_first and failures:
            break

    elapsed = time.time() - t_start
    if not quiet and not verbose:
        print()
    for name, exc_info in failures:
        print("\n" + "=" * 70)
        print(f"FAILED {name}")
        print("-" * 70)
        traceback.print_exception(*exc_info)
    print()
    parts = []
    if passed:
        parts.append(f"{passed} passed")
    if failed:
        parts.append(f"{failed} failed")
    if skipped:
        parts.append(f"{skipped} skipped")
    if xfailed:
        parts.append(f"{xfailed} xfailed")
    print(", ".join(parts) + f" in {elapsed:.2f}s")
    return 0 if failed == 0 else 1


__all__ = [
    "raises", "approx", "fail", "skip", "xfail", "fixture", "mark", "warns",
    "deprecated_call", "main", "Skipped", "Failed", "Approx",
]


if __name__ == "__main__":
    sys.exit(main())
