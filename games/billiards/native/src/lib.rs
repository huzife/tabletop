#![forbid(unsafe_op_in_unsafe_fn)]

mod api;
mod geometry;
mod math;
mod model;
mod physics;
mod replay;
pub mod rules;

pub use api::{CoreError, CoreRequest, CoreResponse, process_json};
pub use model::*;
pub use physics::{predict_shot, simulate_shot, surface_parameters};

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::cell::RefCell;

    thread_local! {
        static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn billiards_alloc(length: u32) -> u32 {
        if length == 0 {
            return 0;
        }
        let bytes = vec![0_u8; length as usize].into_boxed_slice();
        Box::into_raw(bytes) as *mut u8 as u32
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn billiards_dealloc(pointer: u32, length: u32) {
        if length == 0 {
            return;
        }
        // SAFETY: The caller must pass a pointer and length previously returned
        // by `billiards_alloc`, exactly once.
        unsafe {
            let slice = std::ptr::slice_from_raw_parts_mut(pointer as *mut u8, length as usize);
            drop(Box::from_raw(slice));
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn billiards_process(pointer: u32, length: u32) -> u32 {
        // SAFETY: The JavaScript adapter writes `length` initialized bytes into
        // the allocation returned by `billiards_alloc` before calling this.
        let input = unsafe { std::slice::from_raw_parts(pointer as *const u8, length as usize) };
        let output = crate::process_json(input);
        OUTPUT.with(|slot| {
            *slot.borrow_mut() = output;
        });
        0
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn billiards_result_pointer() -> u32 {
        OUTPUT.with(|slot| slot.borrow().as_ptr() as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn billiards_result_length() -> u32 {
        OUTPUT.with(|slot| slot.borrow().len() as u32)
    }
}
