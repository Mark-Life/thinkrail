type Flat<T> = T extends (...args: never) => unknown
	? T
	: T extends object
		? { [K in keyof T]: T[K] }
		: T;
type Equal<A, B> =
	(<T>() => T extends Flat<A> ? 1 : 2) extends <T>() => T extends Flat<B> ? 1 : 2 ? true : false;

/** `A`, compiling only while `B` is exactly the same type: ties a declared shape to the type that owns it. */
export type Same<A extends B, B extends Equal<A, B> extends true ? unknown : never> = A;
