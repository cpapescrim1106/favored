"use client";

const GlobalError = ({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) => {
  return (
    <html>
      <body className="flex items-center justify-center min-h-screen bg-background text-foreground">
        <div className="w-full max-w-md p-8 space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold tracking-tight">Oops!</h2>
            <p className="text-muted-foreground">Something went wrong</p>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border"></div>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                Error Details
              </span>
            </div>
          </div>

          <div className="p-4 rounded-lg border border-border bg-card text-card-foreground">
            <p className="text-sm text-muted-foreground font-mono">
              {error.message || "An unexpected error occurred"}
            </p>
          </div>

          <button
            onClick={() => reset()}
            className="w-full py-3 font-medium text-sm rounded-md transition-colors
                     bg-primary text-primary-foreground hover:bg-primary/90
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  );
};
export default GlobalError;
