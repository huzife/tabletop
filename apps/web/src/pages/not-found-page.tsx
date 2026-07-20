import { ArrowLeft, SearchX } from "lucide-react";
import { EmptyState } from "@tabletop/ui";
import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="page page--centered">
      <EmptyState
        action={
          <Link className="action-link" to="/">
            <ArrowLeft size={16} /> 返回首页
          </Link>
        }
        description="这个地址不存在，或对应内容已经结束。"
        icon={<SearchX size={24} />}
        title="没有找到页面"
      />
    </div>
  );
}
