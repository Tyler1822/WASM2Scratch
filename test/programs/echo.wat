(module
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  ;;@prelude
  ;; reads three lines, prints each reversed with its length
  (func $main (export "_start")
    (local $n i32) (local $k i32) (local $line i32)
    (loop $lines
      (i32.store (i32.const 50000) (i32.const 51000))
      (i32.store (i32.const 50004) (i32.const 200))
      (drop (call $fd_read (i32.const 0) (i32.const 50000) (i32.const 1) (i32.const 50008)))
      (local.set $n (i32.sub (i32.load (i32.const 50008)) (i32.const 1)))
      (call $print_i64 (i64.extend_i32_u (local.get $n)))
      (call $putc (i32.const 58))
      (local.set $k (local.get $n))
      (block $done
        (loop $rev
          (br_if $done (i32.eqz (local.get $k)))
          (local.set $k (i32.sub (local.get $k) (i32.const 1)))
          (call $putc (i32.load8_u offset=51000 (local.get $k)))
          (br $rev)))
      (call $putc (i32.const 10))
      (br_if $lines (i32.lt_u (local.tee $line (i32.add (local.get $line) (i32.const 1))) (i32.const 3))))))
