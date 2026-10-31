from django.shortcuts import render
from django.utils.safestring import mark_safe
from django.views.decorators.csrf import csrf_exempt

from .models import Order, Product, Profile


@csrf_exempt  # expect: sec/csrf-disabled
def update_profile(request):
    profile = Profile.objects.create(**request.POST)  # expect: sec/mass-assignment
    return render(request, 'profile.html', {'bio': mark_safe(profile.bio)})  # expect: sec/xss


def order_summary(request, user):
    count = len(Order.objects.filter(user=user))  # expect: perf/load-all-to-count
    orders = Order.objects.filter(user=user).select_related('product')
    for order in orders:
        product = Product.objects.get(id=order.product_id)  # expect: perf/query-in-loop
    return render(request, 'summary.html', {'count': count, 'fast': Order.objects.filter(user=user).count()})
