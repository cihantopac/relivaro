'use client';
import { useSearchParams } from 'next/navigation';

export default function Go() {
  const searchParams = useSearchParams();
  function go() {
    window.location.href = searchParams.get('redirect') ?? '/'; // expect: sec/open-redirect
  }
  return <button onClick={go}>Continue</button>;
}
