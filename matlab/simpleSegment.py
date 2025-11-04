import os, sys, ctypes
import numpy as np
from ctypes import c_int, c_double, c_ubyte, c_void_p, POINTER

# ---------- locate the compiled library ----------
def _lib_filename(base):
    if sys.platform.startswith("win"):
        return f"{base}.dll"
    elif sys.platform == "darwin":
        return f"{base}.dylib"
    else:
        return f"lib{base}.so"

# If you keep the .dll/.so/.dylib next to this script:
base_dir = os.getcwd() if "__file__" not in globals() else os.path.dirname(os.path.abspath(__file__))
lib_dir  = base_dir
lib_path = os.path.join(lib_dir, _lib_filename("simpleSegment"))
if not os.path.exists(lib_path):
    raise FileNotFoundError(f"Shared library not found: {lib_path}")

lib = ctypes.CDLL(lib_path)

# ---------- optional initialize/terminate ----------
_has_init_term = False
try:
    lib.simpleSegment_initialize.restype = None
    lib.simpleSegment_terminate.restype = None
    _has_init_term = True
except AttributeError:
    pass

# ---------- emx helpers (inputs are emxArray_real_T) ----------
# We will use wrapper constructors so we don't need the struct layout.
lib.emxCreateWrapperND_real_T.argtypes = [POINTER(c_double), c_int, POINTER(c_int)]
lib.emxCreateWrapperND_real_T.restype  = c_void_p
lib.emxDestroyArray_real_T.argtypes    = [c_void_p]
lib.emxDestroyArray_real_T.restype     = None

# Try to bind uint8 emx helpers for the output (if present)
_has_emx_u8 = True
try:
    lib.emxCreateWrapperND_uint8_T.argtypes = [POINTER(c_ubyte), c_int, POINTER(c_int)]
    lib.emxCreateWrapperND_uint8_T.restype  = c_void_p
    lib.emxDestroyArray_uint8_T.argtypes    = [c_void_p]
    lib.emxDestroyArray_uint8_T.restype     = None
except AttributeError:
    _has_emx_u8 = False  # We'll fall back to raw pointer output.

# We'll set the simpleSegment argtypes at call time after we know which path we use.

# ---------- convenience wrapper ----------
def run_simple_segment(frame_u8_hwc: np.ndarray, bkg_u8_hwc: np.ndarray) -> np.ndarray:
    """
    frame_u8_hwc, bkg_u8_hwc: uint8 arrays with shape (H, W, 3)
    returns: uint8 labels image of shape (H, W)
    """
    assert frame_u8_hwc.dtype == np.uint8 and bkg_u8_hwc.dtype == np.uint8
    assert frame_u8_hwc.ndim == 3 and bkg_u8_hwc.ndim == 3
    assert frame_u8_hwc.shape == bkg_u8_hwc.shape
    assert frame_u8_hwc.shape[2] == 3

    if _has_init_term:
        lib.simpleSegment_initialize()

    H, W, _ = frame_u8_hwc.shape

    # MATLAB is column-major: keep Fortran order
    frame_f64_F = np.asfortranarray(frame_u8_hwc.astype(np.float64))
    bkg_f64_F   = np.asfortranarray(bkg_u8_hwc.astype(np.float64))

    # dims [H, W, 3] as int32
    dims3 = np.array([H, W, 3], dtype=np.int32)
    dims3_ct = dims3.ctypes.data_as(POINTER(c_int))

    # Wrap inputs as emxArray_real_T (no internal copy)
    frame_ptr = frame_f64_F.ctypes.data_as(POINTER(c_double))
    bkg_ptr   = bkg_f64_F.ctypes.data_as(POINTER(c_double))
    frame_emx = lib.emxCreateWrapperND_real_T(frame_ptr, 3, dims3_ct)
    bkg_emx   = lib.emxCreateWrapperND_real_T(bkg_ptr,   3, dims3_ct)

    # Prepare output (H*W uint8) and call either emx or raw-pointer variant
    out_len = H * W
    labels_buf = np.asfortranarray(np.zeros(out_len, dtype=np.uint8))  # Fortran to match MATLAB
    labels_ptr = labels_buf.ctypes.data_as(POINTER(c_ubyte))

    try:
        if _has_emx_u8:
            # emx output: simpleSegment(emx_real_T*, emx_real_T*, emx_uint8_T*)
            # Build dims [H, W] for the output
            dims2 = np.array([H, W], dtype=np.int32)
            dims2_ct = dims2.ctypes.data_as(POINTER(c_int))

            labels_emx = lib.emxCreateWrapperND_uint8_T(labels_ptr, 2, dims2_ct)

            # Bind signature for emx output
            lib.simpleSegment.argtypes = [c_void_p, c_void_p, c_void_p]
            lib.simpleSegment.restype  = None

            try:
                lib.simpleSegment(frame_emx, bkg_emx, labels_emx)
            finally:
                lib.emxDestroyArray_uint8_T(labels_emx)
        else:
            # raw pointer output: simpleSegment(emx_real_T*, emx_real_T*, unsigned char*)
            lib.simpleSegment.argtypes = [c_void_p, c_void_p, POINTER(c_ubyte)]
            lib.simpleSegment.restype  = None
            lib.simpleSegment(frame_emx, bkg_emx, labels_ptr)
    finally:
        lib.emxDestroyArray_real_T(bkg_emx)
        lib.emxDestroyArray_real_T(frame_emx)
        if _has_init_term:
            lib.simpleSegment_terminate()

    # Reshape back to (H, W) using Fortran order
    labels_2d = np.reshape(labels_buf, (H, W), order='F')
    return np.array(labels_2d, copy=True)

# ------------- quick test -------------
if __name__ == "__main__":
    H, W = 240, 320
    frame = np.random.randint(0, 256, (H, W, 3), dtype=np.uint8)
    bkg   = np.random.randint(0, 256, (H, W, 3), dtype=np.uint8)
    labels = run_simple_segment(frame, bkg)
    print("Output:", labels.shape, labels.dtype)
