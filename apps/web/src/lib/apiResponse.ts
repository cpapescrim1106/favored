import { NextResponse } from "next/server";

export function jsonData<T>(data: T, message = "Success") {
  return NextResponse.json({ ...data, message });
}

export function internalServerError(message = "Internal server error") {
  return NextResponse.json({ error: message }, { status: 500 });
}

export const unauthorized = (message = "Unauthorized") => {
  return NextResponse.json({ error: message }, { status: 401 });
};

export const forbidden = (message = "Forbidden") => {
  return NextResponse.json({ error: message }, { status: 403 });
};
