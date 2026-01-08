import { Button } from "@/components/ui/button";
import { Paths } from "@/constants/paths";
import Link from "next/link";

const NotFound = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center space-y-8 p-8">
        <h1 className="text-[12rem] font-black text-black/90 leading-none">
          404
        </h1>
        <div className="space-y-3">
          <h2 className="text-3xl font-light text-black/80 tracking-wider">
            Oops! Page Not Found
          </h2>
          <p className="text-gray-500 text-lg">
            Houston, we have a problem... This page seems to have disappeared
            into the void.
          </p>
        </div>
        <div className="h-px w-32 bg-gray-200 mx-auto my-8" />
        <Button
          variant="default"
          size="lg"
          className="tracking-wider hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300"
          asChild
        >
          <Link href={Paths.HOME}>BACK TO EARTH</Link>
        </Button>
      </div>
    </div>
  );
};
export default NotFound;
