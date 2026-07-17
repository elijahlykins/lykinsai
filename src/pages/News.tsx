import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import LandingHeader from "@/components/landing/LandingHeader";
import { NEWS_POSTS, getNewsPost } from "@/lib/newsPosts";
import PageNotFound from "@/lib/PageNotFound";

// Same Inter stack as the Glass landing so the news pages read as part of
// the same site.
const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen bg-white" style={{ fontFamily: LANDING_FONT }}>
    <LandingHeader />
    <main className="pt-28 pb-24 px-5">{children}</main>
  </div>
);

/** Tile + date + headline card, identical anatomy to the landing strip. */
const PostCard = ({ slug }: { slug: string }) => {
  const post = getNewsPost(slug)!;
  return (
    <Link to={`/news/${post.slug}`} className="group block min-w-0">
      <div
        className="grid place-items-center aspect-video rounded-2xl border border-slate-900/10 bg-cover bg-center transition-transform duration-300 group-hover:-translate-y-1"
        style={{ backgroundImage: `url(${post.art})` }}
      >
        <span
          className={`text-lg font-semibold ${
            post.lightArt
              ? "text-teal-950"
              : "text-white [text-shadow:0_2px_18px_rgba(0,0,0,0.55)]"
          }`}
        >
          {post.tag}
        </span>
      </div>
      <p className="mt-3 mb-0.5 text-xs tracking-wide text-slate-400">
        {post.date}
      </p>
      <h3 className="text-sm font-semibold text-slate-900 leading-snug">
        {post.title}
      </h3>
    </Link>
  );
};

/** /news — index of every post: the newest as a featured lead story (copy on
    the left, big art card on the right), the rest as a tile row below. */
export default function News() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  const [featured, ...rest] = NEWS_POSTS;
  return (
    <Shell>
      <div className="max-w-[1120px] mx-auto">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 mb-12">
          News
        </h1>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-14 items-center mb-16 md:mb-20">
          <div className="md:col-span-5 min-w-0 order-2 md:order-1">
            <p className="text-xs tracking-wide text-slate-400 mb-3">
              {featured.date}
            </p>
            <h2 className="text-2xl sm:text-[2.1rem] font-bold tracking-tight leading-[1.12] text-slate-900">
              {featured.title}
            </h2>
            <p className="mt-4 max-w-[40ch] text-[0.95rem] leading-relaxed text-slate-500">
              {featured.lede}
            </p>
            <Link
              to={`/news/${featured.slug}`}
              className="mt-7 inline-flex items-center gap-1 rounded-full border border-slate-900/15 px-5 py-2.5 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-900/5 hover:border-slate-900/30"
            >
              Read More <span aria-hidden="true">›</span>
            </Link>
          </div>
          <Link
            to={`/news/${featured.slug}`}
            aria-label={featured.title}
            className="md:col-span-7 order-1 md:order-2 group grid place-items-center aspect-video rounded-3xl border border-slate-900/10 bg-cover bg-center transition-transform duration-300 hover:-translate-y-1"
            style={{ backgroundImage: `url(${featured.art})` }}
          >
            <span
              className={`text-3xl sm:text-4xl font-semibold tracking-tight ${
                featured.lightArt
                  ? "text-teal-950"
                  : "text-white [text-shadow:0_2px_18px_rgba(0,0,0,0.55)]"
              }`}
            >
              {featured.tag}
            </span>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
          {rest.map((post) => (
            <PostCard key={post.slug} slug={post.slug} />
          ))}
        </div>
      </div>
    </Shell>
  );
}

/** /news/:slug — a full article. */
export function NewsArticle() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getNewsPost(slug) : undefined;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [slug]);

  if (!post) return <PageNotFound />;

  const others = NEWS_POSTS.filter((p) => p.slug !== post.slug).slice(0, 3);

  return (
    <Shell>
      <article className="max-w-[760px] mx-auto">
        <Link
          to="/news"
          className="text-sm font-semibold text-slate-500 hover:text-slate-900 transition-colors"
        >
          ← All posts
        </Link>

        <div
          className="mt-5 aspect-[21/9] rounded-3xl border border-slate-900/10 bg-cover bg-center"
          style={{ backgroundImage: `url(${post.art})` }}
          aria-hidden
        />

        <p className="mt-8 text-xs tracking-wide text-slate-400">
          <span className="font-semibold text-blue-600">{post.tag}</span>
          {" · "}
          {post.date}
        </p>
        <h1 className="mt-2 text-3xl sm:text-[2.6rem] font-bold tracking-tight leading-[1.15] text-slate-900">
          {post.title}
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-slate-500">
          {post.lede}
        </p>

        <div className="mt-10 space-y-10">
          {post.body.map((section, i) => (
            <section key={i}>
              {section.heading ? (
                <h2 className="text-xl font-bold tracking-tight text-slate-900 mb-3">
                  {section.heading}
                </h2>
              ) : null}
              <div className="space-y-4">
                {section.paragraphs.map((p, j) => (
                  <p key={j} className="text-[1.02rem] leading-[1.75] text-slate-700">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-16 pt-10 border-t border-slate-200">
          <h2 className="text-lg font-bold tracking-tight text-slate-900 mb-6">
            More from LYKN
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {others.map((p) => (
              <PostCard key={p.slug} slug={p.slug} />
            ))}
          </div>
        </div>
      </article>
    </Shell>
  );
}
