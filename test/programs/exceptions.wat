(module
  ;;@prelude
  (tag $err (param i32))
  (tag $big (param i64 i32))
  (func $thrower (param $n i32) (result i32)
    (if (i32.gt_s (local.get $n) (i32.const 3)) (then (throw $err (i32.mul (local.get $n) (i32.const 10)))))
    (i32.add (local.get $n) (i32.const 1)))
  (func $deep (param $n i32) (result i32)
    (local $keep i32)
    (local.set $keep (i32.mul (local.get $n) (i32.const 1000)))
    (if (result i32) (i32.eqz (local.get $n))
      (then (throw $big (i64.const -77) (i32.const 5)))
      (else (i32.add (local.get $keep) (call $deep (i32.sub (local.get $n) (i32.const 1)))))))
  ;; catch with payload, locals visible in the handler
  (func $safe (param $n i32) (result i32)
    (local $before i32)
    (local.set $before (i32.const 7))
    (try (result i32)
      (do
        (local.set $before (i32.const 8))
        (call $thrower (local.get $n)))
      (catch $err
        (i32.add (local.get $before)))))
  ;; nested tries, rethrow and catch_all, exception crossing a loop
  (func $nested (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (try
      (do
        (try
          (do
            (loop $l
              (local.set $acc (i32.add (local.get $acc) (call $thrower (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $l (i32.lt_s (local.get $i) (local.get $n)))))
          (catch $err
            (local.set $acc (i32.add (local.get $acc) (i32.const 100000)))
            (drop)
            (rethrow 0))))
      (catch_all
        (local.set $acc (i32.add (local.get $acc) (i32.const 1)))))
    (local.get $acc))
  ;; delegate to the outer try; recursion unwinding several frames
  (func $delegating (result i32)
    (try (result i32)
      (do
        (try (result i32)
          (do (call $deep (i32.const 4)))
          (delegate 0)))
      (catch $big
        (i32.wrap_i64 (i64.sub (i64.const 0) (i64.extend_i32_u (i32.const 0))))
        (drop)
        (i32.add (i32.wrap_i64 (i64.mul (i64.const -1) (i64.const 1))))
        (drop)
        (drop)
        (i32.const 123))))
  (func $uncaught (call $p (call $thrower (i32.const 99))))
  (func $main (export "_start")
    (call $p (call $safe (i32.const 2)))
    (call $p (call $safe (i32.const 5)))
    (call $p (call $nested (i32.const 3)))
    (call $p (call $nested (i32.const 6)))
    (call $p (call $delegating))
    (call $p (i32.const 42))
    (call $uncaught)
    (call $p (i32.const -1))))
